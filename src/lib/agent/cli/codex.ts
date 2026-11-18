import { t as translate } from "@/lib/i18n";
import fs from "node:fs/promises";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import type { EngineCatalog, EngineModel } from "@/lib/agent-models";
import { getProject } from "@/lib/projects";
import { forgetProviderStatus, providerStatus } from "./detect";
import { serveTools } from "./mcp-server";
import { cliEnv, eachLine, removeScratch, startProgram, stopProgram, tail } from "./process";
import { cliSystemPrompt, explainFailure, isDestructiveCommand, isInsideFolder, isReadOnlyCommand, ReplyCollector, resumedContent, toolSpecs, TURN_TIMEOUT_MS, withHistory, type CliTurn, type TurnBlock } from "./shared";
import { AGENT_DIR, prepareWorkspace, readSession, resetSession, saveSession } from "./workspace";

/**
 * One agent turn through the user's Codex with its whole harness, driven over `codex app-server`
 * (JSON-RPC, one JSON object per line on stdin/stdout). The thread is kept per project and resumed every
 * turn, so the chat continues like a Codex session. It works in the project folder with its own tools
 * (terminal inside a workspace-write sandbox, files, web, skills); the studio's tools reach it as an MCP
 * server on localhost. Whatever Codex would ask in a terminal (a command, a file change) is asked in the
 * studio's chat.
 */

const SERVER = "videogen";

type Id = number | string;
interface RpcMessage {
  id?: Id;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code?: number; message?: string };
}

/** Codex answered a request with an error (as opposed to the program dying). */
class RpcError extends Error {}

/** Requests and answers over the program's stdio. */
class Rpc {
  private next = 1;
  private pending = new Map<Id, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  constructor(
    private child: ChildProcess,
    onNotification: (method: string, params: Record<string, unknown>) => void,
    onRequest: (method: string, params: Record<string, unknown>) => Promise<unknown>,
  ) {
    eachLine(child.stdout, (line) => {
      let message: RpcMessage;
      try { message = JSON.parse(line); } catch { return; }
      if (message.method && message.id !== undefined) {
        // A request from Codex (tool call, approval): answer it, even with an error.
        onRequest(message.method, message.params ?? {})
          .then((result) => this.send({ id: message.id, result }))
          .catch((error: unknown) => this.send({ id: message.id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } }));
      } else if (message.method) {
        onNotification(message.method, message.params ?? {});
      } else if (message.id !== undefined) {
        const waiter = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) waiter?.reject(new RpcError(message.error.message ?? `error ${message.error.code}`));
        else waiter?.resolve(message.result);
      }
    });
  }
  private send(message: RpcMessage) {
    if (this.child.stdin?.writable) this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
  request<T>(method: string, params: unknown): Promise<T> {
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.send({ id, method, params: params as Record<string, unknown> });
    });
  }
  notify(method: string, params?: unknown) {
    this.send({ method, ...(params === undefined ? {} : { params: params as Record<string, unknown> }) });
  }
  failAll(error: Error) {
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
  }
}

interface CodexModel {
  id?: string; model?: string; displayName?: string; description?: string; hidden?: boolean; isDefault?: boolean;
  supportedReasoningEfforts?: { reasoningEffort?: string }[]; defaultReasoningEffort?: string;
}
const globalForCodex = globalThis as unknown as { __videogenCodexModels?: { at: number; catalog: EngineCatalog } };
const MODELS_TTL_MS = 10 * 60_000;

/**
 * The models the user's Codex offers (its own `model/list`, the same list as its picker) with their reasoning
 * levels, kept for a few minutes. Never throws: what went wrong comes back as the catalog's problem.
 */
export async function listCodexModels(fresh = false): Promise<EngineCatalog> {
  const cached = globalForCodex.__videogenCodexModels;
  if (!fresh && cached && Date.now() - cached.at < MODELS_TTL_MS) return cached.catalog;
  const status = await providerStatus("codex");
  if (status.state !== "ready" || !status.path) return { models: [], problem: status.problem ?? translate("Codex is not available.") };
  const child = startProgram(status.path, ["app-server"], { env: cliEnv() });
  child.stdin?.on("error", () => { /* it exited first: the close event says so */ });
  const rpc = new Rpc(child, () => {}, async (method) => { throw new Error(`VideoGen no atiende ${method}`); });
  const exited = new Promise<never>((_, reject) => {
    child.on("error", reject);
    child.on("close", (code) => reject(new Error(translate("Codex is closed (code {0}).", code))));
  });
  exited.catch(() => {});
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Codex no ha respondido a tiempo.")), 20_000); });
  const step = <T>(promise: Promise<T>) => Promise.race([promise, exited, timeout]);
  try {
    await step(rpc.request("initialize", {
      clientInfo: { name: "videogen", title: "VideoGen", version: "0.1.0" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    }));
    rpc.notify("initialized");
    const models: EngineModel[] = [];
    let defaultModel: string | undefined;
    let cursor: string | null = null;
    do {
      const page: { data?: CodexModel[]; nextCursor?: string | null } = await step(rpc.request("model/list", { cursor, limit: 100 }));
      for (const m of page.data ?? []) {
        const id = m.model || m.id;
        if (!id || m.hidden) continue;
        if (m.isDefault) defaultModel = id;
        models.push({
          id,
          label: m.displayName || id,
          hint: m.description || undefined,
          efforts: (m.supportedReasoningEfforts ?? []).map((e) => e.reasoningEffort ?? "").filter(Boolean),
          defaultEffort: m.defaultReasoningEffort || undefined,
        });
      }
      cursor = page.nextCursor ?? null;
    } while (cursor && models.length < 200);
    const catalog: EngineCatalog = { models, defaultModel };
    globalForCodex.__videogenCodexModels = { at: Date.now(), catalog };
    return catalog;
  } catch (error) {
    return { models: [], problem: `No he podido leer los modelos de Codex: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    clearTimeout(timer);
    rpc.failAll(new Error("Codex se ha cerrado."));
    stopProgram(child);
  }
}

interface ThreadItem {
  type?: string; id?: string; text?: string; tool?: string; server?: string;
  command?: string | string[]; exitCode?: number | null; status?: string; query?: string;
}
interface TurnInfo { id?: string; status?: string; error?: { message?: string; additionalDetails?: string | null } | null }

const short = (text: string, max = 70) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
/**
 * The command as the user would type it: Codex reports it wrapped in its shell ("…pwsh.exe" -Command "…",
 * bash -lc '…') and JSON-escaped; the chat shows only what runs.
 */
function commandText(command: unknown): string {
  const raw = Array.isArray(command) ? command.join(" ") : typeof command === "string" ? command : "";
  const unescaped = raw.replace(/\\\\/g, "\\").replace(/\\"/g, "\"");
  const wrapped = /^(?:"[^"]*?(?:pwsh|powershell|bash|zsh|sh|cmd)(?:\.exe)?"|[^"\s]*?(?:pwsh|powershell|bash|zsh|sh|cmd)(?:\.exe)?)\s+(?:-NoProfile\s+)?(?:-Command|-lc|-c|\/c)\s+([\s\S]+)$/i.exec(unescaped);
  return (wrapped ? wrapped[1].replace(/^(["'])([\s\S]*)\1$/, "$2") : unescaped).trim();
}

export async function runCodex(turn: CliTurn): Promise<string> {
  const { input } = turn;
  const projectId = input.ctx.projectId;
  let status = await providerStatus("codex");
  // A remembered problem may be fixed by now (installed or signed in since): check again before refusing.
  if (status.state !== "ready") status = await providerStatus("codex", true);
  if (status.state !== "ready" || !status.path) throw new Error(status.problem ?? translate("Codex is not available."));

  input.onStep?.(translate("Looking at your files"));
  const workspace = prepareWorkspace(projectId, "codex");
  const blocks = await turn.content();
  const assets = (getProject(projectId)?.edit.assets ?? []).map((a) => a.id);
  const saved = readSession(projectId, "codex");
  // Contact sheets go in as image files inside the project, where the sandbox lets Codex read them.
  const sheets = path.join(/*turbopackIgnore: true*/ workspace, AGENT_DIR, "tmp", `hojas-${Date.now()}`);

  const reply = new ReplyCollector(input.onText);
  const mcp = await serveTools(SERVER, toolSpecs(input.tools), async (name, args) => {
    reply.tool(name);
    return turn.callTool(name, args);
  });
  const child = startProgram(status.path, ["app-server"], { cwd: workspace, env: cliEnv() });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-20_000); });
  child.stdin?.on("error", () => { /* the program exited first: its close event reports why */ });

  let done: ((turn: TurnInfo) => void) | null = null;
  let lastError = "";
  const streaming = new Map<string, string>();
  const finished = new Promise<TurnInfo>((resolve) => { done = resolve; });

  const rpc = new Rpc(
    child,
    (method, params) => {
      const item = params.item as ThreadItem | undefined;
      switch (method) {
        case "item/agentMessage/delta": {
          // Words as they are written, for the live view.
          const id = String(params.itemId ?? "");
          const text = (streaming.get(id) ?? "") + String(params.delta ?? "");
          streaming.set(id, text);
          input.onText?.(text);
          break;
        }
        case "item/started":
          if (item?.type === "commandExecution") input.onStep?.(`Ejecutar: ${short(commandText(item.command))}`);
          else if (item?.type === "fileChange") input.onStep?.(translate("Edit Files"));
          else if (item?.type === "webSearch") input.onStep?.(translate("Search on the web"));
          break;
        case "item/completed":
          if (item?.type === "agentMessage" && item.text) reply.text(item.text);
          else if (item?.type === "commandExecution") {
            reply.tool("shell");
            input.onAction({ tool: "terminal", label: `Ejecutar: ${short(commandText(item.command))}`, ok: item.exitCode === 0 || item.status === "completed" });
            input.onStep?.(translate("Thinking of the next step"));
          } else if (item?.type === "fileChange") {
            reply.tool("apply_patch");
            input.onAction({ tool: "archivos", label: translate("Edit Files"), ok: item.status === "completed" });
          } else if (item?.type === "webSearch") {
            reply.tool("web_search");
            input.onAction({ tool: "web", label: translate("Search on the web {0}", item.query ? `: ${short(item.query, 50)}` : ""), ok: true });
          }
          break;
        case "turn/completed":
          done?.((params.turn as TurnInfo | undefined) ?? { status: "completed" });
          break;
        case "error": {
          const error = params.error as TurnInfo["error"];
          if (!params.willRetry && error?.message) lastError = [error.message, error.additionalDetails].filter(Boolean).join(" · ");
          break;
        }
      }
    },
    async (method, params) => {
      switch (method) {
        // What Codex would ask in a terminal is asked in the chat.
        // Under «Ejecución automática» only what is destructive or reaches outside the project still reaches the user.
        case "item/commandExecution/requestApproval": {
          const command = commandText(params.command);
          // Reading a file or probing a clip never needs the user (Codex does not trust PowerShell readers on its own).
          if (isReadOnlyCommand(command) && !params.networkApprovalContext) return { decision: "accept" };
          const allowed = await turn.approve({ title: "Ejecutar un comando", detail: command || String(params.reason ?? "") }, { mustAsk: !command || isDestructiveCommand(command) || !!params.networkApprovalContext });
          return { decision: allowed ? "accept" : "decline" };
        }
        case "item/fileChange/requestApproval": {
          const root = typeof params.grantRoot === "string" ? params.grantRoot : "";
          const allowed = await turn.approve({ title: translate("Write Files"), detail: String(params.reason ?? (root || translate("Changes to the project folder files"))) }, { mustAsk: !!root && !isInsideFolder(workspace, root) });
          return { decision: allowed ? "accept" : "decline" };
        }
        case "execCommandApproval": {
          const command = commandText(params.command);
          if (isReadOnlyCommand(command)) return { decision: "approved" };
          const allowed = await turn.approve({ title: "Ejecutar un comando", detail: command }, { mustAsk: !command || isDestructiveCommand(command) });
          return { decision: allowed ? "approved" : { denied: { rejection: "El usuario no lo ha permitido." } } };
        }
        case "applyPatchApproval": {
          const root = typeof params.grantRoot === "string" ? params.grantRoot : "";
          const allowed = await turn.approve({ title: translate("Write Files"), detail: String(params.reason ?? (root || translate("File changes"))) }, { mustAsk: !!root && !isInsideFolder(workspace, root) });
          return { decision: allowed ? "approved" : { denied: { rejection: "El usuario no lo ha permitido." } } };
        }
        case "mcpServer/elicitation/request":
          // The studio's own tools never need a second confirmation; anyone else's are declined.
          return params.serverName === SERVER ? { action: "accept", content: {}, _meta: null } : { action: "decline", content: null, _meta: null };
        case "item/tool/requestUserInput":
          return { answers: {} };
        default:
          throw new Error(`VideoGen no atiende ${method}`);
      }
    },
  );

  let ended = false;
  const exited = new Promise<never>((_, reject) => {
    child.on("error", (error) => { if (!ended) reject(explainFailure("codex", error.message)); });
    child.on("close", (code) => { if (!ended) reject(explainFailure("codex", lastError || tail(stderr) || translate("has ended unanswered (code {0})", code), turn.model)); });
  });
  exited.catch(() => {});
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(translate("Codex has been over {0} minutes unfinished and I've stopped him.", TURN_TIMEOUT_MS / 60_000))), TURN_TIMEOUT_MS);
  });
  // «Detener»: the finally below closes the program.
  const stopped = new Promise<never>((_, reject) => {
    if (input.signal?.aborted) reject(new Error("Detenido por el usuario."));
    input.signal?.addEventListener("abort", () => reject(new Error("Detenido por el usuario.")), { once: true });
  });
  stopped.catch(() => {});
  const step = <T>(promise: Promise<T>) => Promise.race([promise, exited, timeout, stopped]);
  const rpcFailure = (error: unknown): never => { throw error instanceof RpcError ? explainFailure("codex", error.message, turn.model) : error; };

  try {
    await step(rpc.request("initialize", {
      clientInfo: { name: "videogen", title: "VideoGen", version: "0.1.0" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    }));
    rpc.notify("initialized");

    // An older Codex without account/read answers with an error: the turn itself then reports any sign-in problem.
    const account = await step(rpc.request<{ account?: unknown; requiresOpenaiAuth?: boolean }>("account/read", {}).catch((error: unknown) => {
      if (error instanceof RpcError) return null;
      throw error;
    }));
    if (account && !account.account && account.requiresOpenaiAuth) {
      forgetProviderStatus("codex");
      throw explainFailure("codex", "not logged in");
    }

    const thread = {
      cwd: workspace,
      model: turn.model || null,
      // Its terminal writes only inside the project, and every command passes through VideoGen, which asks the
      // user or, under «Ejecución automática», lets it run unless it is destructive.
      sandbox: "workspace-write",
      approvalPolicy: "untrusted",
      developerInstructions: cliSystemPrompt(input.system, "codex", `${SERVER}__`),
      // The studio's server is the only MCP server, and its tools run without a second confirmation.
      config: {
        mcp_servers: {
          [SERVER]: { url: mcp.url, http_headers: mcp.headers, tool_timeout_sec: 900, startup_timeout_sec: 30, default_tools_approval_mode: "approve" },
        },
      },
    };
    let threadId: string | undefined;
    if (saved) {
      const resumed = await step(rpc.request<{ thread?: { id?: string } }>("thread/resume", { threadId: saved.id, ...thread }).catch((error: unknown) => {
        if (error instanceof RpcError) return null; // gone (archived, deleted, another computer): start a new one
        throw error;
      }));
      threadId = resumed?.thread?.id;
      if (!threadId) resetSession(projectId);
    }
    const isNew = !threadId;
    if (!threadId) {
      const started = await step(rpc.request<{ thread?: { id?: string } }>("thread/start", { ...thread, ephemeral: false }).catch(rpcFailure));
      threadId = started?.thread?.id;
    }
    if (!threadId) throw new Error(translate("Codex hasn't opened the conversation."));
    saveSession(projectId, { provider: "codex", id: threadId, seenAssets: assets });

    // A resumed thread already saw the contact sheets: send them again only when there are new files.
    const content: TurnBlock[] = isNew ? withHistory(input, blocks)
      : saved && assets.every((id) => saved.seenAssets.includes(id)) ? resumedContent(blocks) : blocks;
    const items: unknown[] = [];
    let n = 0;
    for (const block of content) {
      if (block.type === "text") items.push({ type: "text", text: block.text, text_elements: [] });
      else if (block.type === "image" && block.source.type === "base64") {
        await fs.mkdir(sheets, { recursive: true });
        const file = path.join(/*turbopackIgnore: true*/ sheets, `hoja-${++n}.jpg`);
        await fs.writeFile(file, Buffer.from(block.source.data, "base64"));
        items.push({ type: "localImage", path: file });
      }
    }

    input.onStep?.(translate("Thinking about the changes"));
    // The effort chosen in the message box; without one Codex uses the model's own default.
    await step(rpc.request("turn/start", { threadId, input: items, ...(turn.effort ? { effort: turn.effort } : {}) }).catch(rpcFailure));
    const result = await step(finished);
    if (result.status === "failed") throw explainFailure("codex", [result.error?.message, result.error?.additionalDetails, lastError].filter(Boolean).join(" · "), turn.model);
    if (result.status === "interrupted") throw new Error("Codex ha interrumpido el turno antes de terminar.");
    return reply.reply(input.ctx.message);
  } finally {
    ended = true;
    clearTimeout(timer);
    rpc.failAll(new Error("Codex se ha cerrado."));
    stopProgram(child);
    await mcp.close();
    // Not awaited: the stopped program may hold the files for a moment and the user should not wait for it.
    void removeScratch(sheets);
  }
}


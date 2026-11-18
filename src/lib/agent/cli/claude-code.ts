import { t as translate } from "@/lib/i18n";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getProject } from "@/lib/projects";
import { providerStatus } from "./detect";
import { serveTools, type McpEndpoint } from "./mcp-server";
import { cliEnv, eachLine, removeScratch, startProgram, stopProgram, tail } from "./process";
import { approvalRequest, cliSystemPrompt, describeOwnTool, explainFailure, isReadOnlyCommand, mustAskEvenInAuto, plainText, ReplyCollector, resumedContent, toolSpecs, TURN_TIMEOUT_MS, withHistory, type CliTurn, type TurnBlock } from "./shared";
import { prepareWorkspace, readSession, resetSession, saveSession } from "./workspace";

/**
 * One agent turn through the user's Claude Code, with its whole harness: its own tools (files, search,
 * terminal, web, planning, subagents), its skills plus the studio's, and a conversation that continues
 * from turn to turn (`--resume`). It works in the project folder; the studio's tools reach it as an MCP
 * server on localhost. Anything that would ask for permission in a terminal is asked in the studio's chat
 * instead (`--permission-prompt-tool`).
 */

const SERVER = "videogen";
/** The MCP tool Claude Code calls to ask for permission; the user answers in the chat. */
const PERMISSION_TOOL = "aprobar_permiso";

/** Its own tools that never need asking: they only look. Everything else goes through the chat. */
const PRE_APPROVED = ["Read", "Glob", "Grep", "LS", "WebSearch", "WebFetch", "TodoWrite", "Task", "Agent", "Skill", "NotebookRead", "ToolSearch"];

interface ContentBlock { type: string; text?: string; name?: string; id?: string; input?: Record<string, unknown>; tool_use_id?: string; is_error?: boolean; content?: unknown }
interface StreamEvent {
  type?: string;
  subtype?: string;
  session_id?: string;
  is_error?: boolean;
  result?: string;
  errors?: string[];
  mcp_servers?: { name: string; status: string }[];
  message?: { content?: ContentBlock[] };
  event?: { type?: string; delta?: { type?: string; text?: string }; content_block?: { type?: string } };
}

/** The saved session no longer exists (cleared in Claude Code, another computer): start a new one. */
class LostSession extends Error {}

export async function runClaudeCode(turn: CliTurn): Promise<string> {
  const { input } = turn;
  const projectId = input.ctx.projectId;
  let status = await providerStatus("claude-code");
  // A remembered problem may be fixed by now (installed or signed in since): check again before refusing.
  if (status.state !== "ready") status = await providerStatus("claude-code", true);
  if (status.state !== "ready" || !status.path) throw new Error(status.problem ?? translate("Claude Code is not available."));

  input.onStep?.(translate("Looking at your files"));
  const workspace = prepareWorkspace(projectId, "claude-code");
  const blocks = await turn.content();
  const assets = (getProject(projectId)?.edit.assets ?? []).map((a) => a.id);
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "videogen-claude-"));
  const reply = new ReplyCollector(input.onText);
  const mcp = await serveTools(SERVER, [
    ...toolSpecs(input.tools),
    {
      name: PERMISSION_TOOL,
      description: "Use within VideoGen to ask the user for permission. Don't call her.",
      inputSchema: { type: "object", properties: { tool_name: { type: "string" }, input: { type: "object" } }, required: ["tool_name"] },
    },
  ], async (name, args) => {
    if (name !== PERMISSION_TOOL) return turn.callTool(name, args);
    const { tool_name: tool, input: toolInput } = (args ?? {}) as { tool_name?: string; input?: Record<string, unknown> };
    const asked = String(tool ?? "");
    // A command that only reads (list, read, ffprobe) runs without a question, like its Read tool.
    const readOnly = (asked === "Bash" || asked === "PowerShell") && isReadOnlyCommand(String(toolInput?.command ?? ""));
    const allowed = readOnly || await turn.approve(approvalRequest(asked, toolInput), { mustAsk: mustAskEvenInAuto(asked, toolInput, workspace) });
    return { ok: true, text: JSON.stringify(allowed ? { behavior: "allow", updatedInput: toolInput ?? {} } : { behavior: "deny", message: translate("The user has not allowed it. He is still without it or explain what you need.") }) };
  });

  try {
    const saved = readSession(projectId, "claude-code");
    const fresh = (): TurnBlock[] => withHistory(input, blocks);
    // A resumed session already saw the contact sheets: send them again only when there are new files.
    const resumed = (): TurnBlock[] => saved && assets.every((id) => saved.seenAssets.includes(id)) ? resumedContent(blocks) : blocks;
    try {
      return await attempt(turn, { status: status.path, workspace, scratch, mcp, reply, resume: saved?.id ?? null, content: saved ? resumed() : fresh(), assets });
    } catch (error) {
      if (!(error instanceof LostSession)) throw error;
      resetSession(projectId);
      return await attempt(turn, { status: status.path, workspace, scratch, mcp, reply, resume: null, content: fresh(), assets });
    }
  } finally {
    await mcp.close();
    // Not awaited: the stopped program may hold the folder for a moment and the user should not wait for it.
    void removeScratch(scratch);
  }
}

async function attempt(turn: CliTurn, o: {
  status: string; workspace: string; scratch: string; mcp: McpEndpoint; reply: ReplyCollector;
  resume: string | null; content: TurnBlock[]; assets: string[];
}): Promise<string> {
  const { input } = turn;
  const projectId = input.ctx.projectId;
  const sessionId = o.resume ?? randomUUID();
  const files = {
    system: path.join(/*turbopackIgnore: true*/ o.scratch, "system.md"),
    mcp: path.join(/*turbopackIgnore: true*/ o.scratch, "mcp.json"),
    settings: path.join(/*turbopackIgnore: true*/ o.scratch, "settings.json"),
  };
  await Promise.all([
    fs.writeFile(files.system, cliSystemPrompt(input.system, "claude-code", `mcp__${SERVER}__`)),
    fs.writeFile(files.mcp, JSON.stringify({ mcpServers: { [SERVER]: { type: "http", url: o.mcp.url, headers: o.mcp.headers } } })),
    // The user's hooks (style injections, reminders) are for their own sessions, not the studio's agent.
    fs.writeFile(files.settings, JSON.stringify({ disableAllHooks: true })),
  ]);
  const args = [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--append-system-prompt-file", files.system,
    "--mcp-config", files.mcp,
    "--strict-mcp-config",
    "--settings", files.settings,
    "--allowedTools", [`mcp__${SERVER}`, ...PRE_APPROVED].join(","),
    "--permission-prompt-tool", `mcp__${SERVER}__${PERMISSION_TOOL}`,
    ...(o.resume ? ["--resume", o.resume] : ["--session-id", sessionId]),
    ...(turn.model ? ["--model", turn.model] : []),
    ...(turn.effort ? ["--effort", turn.effort] : []),
  ];
  const env = cliEnv({
    // Generations and media analysis can take minutes; never let the CLI hide the studio's tools behind a search.
    MCP_TOOL_TIMEOUT: "900000",
    MAX_MCP_OUTPUT_TOKENS: "50000",
    ENABLE_TOOL_SEARCH: "false",
    // Nor the user's claude.ai connectors or IDE: the studio's server is the only one.
    ENABLE_CLAUDEAI_MCP_SERVERS: "false",
    CLAUDE_CODE_AUTO_CONNECT_IDE: "0",
  });
  input.onStep?.(translate("Thinking about the changes"));

  return new Promise<string>((resolve, reject) => {
    const child = startProgram(o.status, args, { cwd: o.workspace, env });
    const own = new Map<string, { name: string; label: string; record: boolean }>();
    let stderr = "";
    let streaming = "";
    let settled = false;
    const finish = (error: Error | null, text = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stopProgram(child);
      if (error) reject(error); else resolve(text);
    };
    const timer = setTimeout(() => finish(new Error(translate("Claude Code has been over {0} minutes unfinished and I've stopped him.", TURN_TIMEOUT_MS / 60_000))), TURN_TIMEOUT_MS);
    if (input.signal?.aborted) finish(new Error("Detenido por el usuario."));
    input.signal?.addEventListener("abort", () => finish(new Error("Detenido por el usuario.")), { once: true });

    eachLine(child.stdout, (line) => {
      let event: StreamEvent;
      try { event = JSON.parse(line); } catch { return; }
      switch (event.type) {
        case "system":
          if (event.subtype === "init") {
            const server = event.mcp_servers?.find((s) => s.name === SERVER);
            if (server && /failed|needs-auth/.test(server.status)) finish(new Error(translate("Claude Code has not been able to connect with the study tools.")));
            // From here on the conversation exists: the next turn continues it.
            saveSession(projectId, { provider: "claude-code", id: event.session_id || sessionId, seenAssets: o.assets });
          }
          break;
        case "stream_event": {
          // Words as they are written, for the live view.
          const e = event.event;
          if (e?.type === "content_block_start" && e.content_block?.type === "text") streaming = "";
          if (e?.type === "content_block_delta" && e.delta?.type === "text_delta" && e.delta.text) {
            streaming += e.delta.text;
            input.onText?.(streaming);
          }
          break;
        }
        case "assistant":
          for (const block of event.message?.content ?? []) {
            if (block.type === "text" && block.text) o.reply.text(block.text);
            else if (block.type === "tool_use" && block.name) {
              o.reply.tool(block.name);
              if (block.name.startsWith(`mcp__${SERVER}__`)) continue; // the studio records its own tools
              const what = describeOwnTool(block.name, block.input);
              input.onStep?.(what.label);
              if (block.id) own.set(block.id, { name: block.name, ...what });
            }
          }
          break;
        case "user":
          // Results of its own tools: the ones worth telling the user become action chips.
          for (const block of event.message?.content ?? []) {
            const call = block.type === "tool_result" && block.tool_use_id ? own.get(block.tool_use_id) : undefined;
            if (!call) continue;
            own.delete(block.tool_use_id!);
            const denied = block.is_error && /no lo ha permitido|permission|denied/i.test(JSON.stringify(block.content ?? ""));
            if (call.record) input.onAction({ tool: call.name, label: denied ? `${call.label} (no permitido)` : call.label, ok: !block.is_error });
            input.onStep?.(translate("Thinking of the next step"));
          }
          break;
        case "result": {
          const failed = event.is_error || (event.subtype && event.subtype !== "success");
          const why = [event.result, ...(event.errors ?? []), event.subtype === "success" ? "" : event.subtype].filter(Boolean).join(" · ");
          if (failed && o.resume && /no conversation found|session.{0,40}not found|could not find session/i.test(why)) finish(new LostSession(why));
          else if (failed) finish(explainFailure("claude-code", why, turn.model));
          else finish(null, o.reply.reply(input.ctx.message) || plainText(event.result ?? ""));
          break;
        }
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-20_000); });
    child.on("error", (error) => finish(explainFailure("claude-code", error.message)));
    child.on("close", (code) => {
      const why = tail(stderr) || translate("has ended unanswered (code {0})", code);
      finish(o.resume && /no conversation found|session.{0,40}not found/i.test(why) ? new LostSession(why) : explainFailure("claude-code", why, turn.model));
    });

    const message = { type: "user", message: { role: "user", content: o.content }, parent_tool_use_id: null, session_id: sessionId };
    child.stdin?.on("error", () => { /* the program exited first: its close event reports why */ });
    child.stdin?.end(`${JSON.stringify(message)}\n`);
  });
}

import { t as translate, languageName } from "@/lib/i18n";
import path from "node:path";
import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import { AGENT_PROVIDER_INFO, type CliProviderId } from "@/lib/app-settings-shared";
import { hyperframesCommand } from "@/lib/runtime";
import type { AgentTool } from "../tools";
import type { ModelInput } from "../run";
import type { ApprovalRequest } from "../approvals";
import { forgetProviderStatus, SIGN_IN } from "./detect";

/** What the installed-program providers share: the studio's tools as JSON Schema, the prompt, and error wording. */

export type TurnBlock = Anthropic.Beta.BetaContentBlockParam;

/** What a provider needs from the turn besides the model input. */
export interface CliTurn {
  input: ModelInput;
  /** Model chosen in the message box or Ajustes; empty uses the program's default. */
  model: string;
  /** Reasoning effort chosen next to the model; empty uses the model's default. */
  effort: string;
  /** The user's message plus the contact sheets (text and base64 JPEG blocks). */
  content: () => Promise<TurnBlock[]>;
  /** Runs one studio tool under the user's permissions, with raw JSON arguments. Never throws. */
  callTool: (name: string, args: unknown) => Promise<ToolResult>;
  /**
   * The program wants to use one of its own tools that needs permission (a command, writing a file): true
   * when the user allows it in the chat, or at once under «Ejecución automática».
   */
  approve: (request: ApprovalRequest, options?: { mustAsk?: boolean }) => Promise<boolean>;
  /** «Ejecución automática»: the program may run its own tools without asking. */
  autoApprove: boolean;
}

/** A tool's answer to the model: text, plus base64 JPEG filmstrips some tools leave so it can see its cut. */
export interface ToolResult {
  ok: boolean;
  text: string;
  images?: string[];
}

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** The studio's tools as JSON Schema (what an MCP client or Codex expects). */
export function toolSpecs(tools: AgentTool[]): ToolSpec[] {
  return tools.map((t) => {
    const inputSchema = z.toJSONSchema(t.schema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
    delete inputSchema.$schema;
    return { name: t.name, description: t.description, inputSchema: { type: "object", ...inputSchema } };
  });
}

/**
 * Validates raw arguments like the Anthropic tool runner does and runs the tool; a bad call comes back as an
 * error the model can read and fix.
 */
export function toolCaller(tools: AgentTool[], run: (def: AgentTool, args: unknown) => Promise<ToolResult>) {
  return async (name: string, args: unknown): Promise<ToolResult> => {
    const def = tools.find((t) => t.name === name);
    if (!def) return { ok: false, text: `Error: la herramienta ${name} no existe.` };
    const parsed = def.schema.safeParse(unprefixButtons(args ?? {}));
    if (!parsed.success) {
      return { ok: false, text: translate("Error: data not valid for {0}: {1}", name, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")) };
    }
    return run(def, parsed.data);
  };
}

/**
 * Buttons name a studio tool; a program that sees our tools as `mcp__videogen__generate_video` tends to
 * write that full name in propose_actions, which would make every button invalid.
 */
function unprefixButtons(args: unknown): unknown {
  if (!args || typeof args !== "object" || !Array.isArray((args as { actions?: unknown }).actions)) return args;
  const actions = (args as { actions: unknown[] }).actions.map((a) =>
    a && typeof a === "object" && typeof (a as { tool?: unknown }).tool === "string"
      ? { ...a, tool: (a as { tool: string }).tool.replace(/^(mcp__[\w-]+?__|videogen(__|\.|\/))/, "") }
      : a,
  );
  return { ...args, actions };
}

/**
 * Added to the studio's instructions when an installed program runs the agent. The program keeps its own
 * harness (its tools, skills, planning): the studio adds its role, its tools and where the line is.
 */
export function cliSystemPrompt(system: string, provider: CliProviderId, toolPrefix: string): string {
  return `${system}

Your environment is ${AGENT_PROVIDER_INFO[provider].label} in the project folder. Read AGENTS.md or CLAUDE.md. Use the studio tools${toolPrefix ? ` with the ${toolPrefix} prefix. In propose_actions, use tool names without that prefix, for example generate_video.` : "."} Your own tools provide file inspection, search, a terminal, web access, and planning. Load the relevant studio skill before editing, cutting, styling text, drawing a graphic, or reviewing a final result. The project instructions list the skills.

For original graphics, pass HTML, CSS, and animation as text to create_graphic. The studio renders the clip. When one file is insufficient, load hyperframes-compositions. Author animations, transitions, catalog blocks, multiple scenes, 3D, or Lottie compositions under agent/compositions/ with the pinned HyperFrames CLI. Import and render them through render_composition.

For corrections to an existing timeline, load edit-notes, patch IDs with apply_edit_notes, and inspect every pending batch from review_edit_notes. Preserve timing and unaffected layers. Make changes only with studio tools. Put auxiliary files under agent/. Request only permissions you need. If the user denies one, continue within the permissions they granted. If write_script cannot run without an API key, write scenes with add_scene.

Reply in ${languageName()} in concise plain text, regardless of the language used in tool output, errors, or permission prompts.`;
}

/**
 * The turn as text and images for a program that does not take earlier messages: the recent conversation
 * first, then the user's message with the state and the contact sheets.
 */
export function withHistory(input: ModelInput, blocks: TurnBlock[]): TurnBlock[] {
  if (!input.history.length) return blocks;
  const transcript = input.history.map((m) => `${m.role === "user" ? "Usuario" : translate("You (VideoGen)")}: ${m.content}`).join("\n\n");
  return [{ type: "text", text: `<conversacion_anterior>\n${transcript}\n</conversacion_anterior>` }, ...blocks];
}

/** A known asset can have new, denser reference evidence; never discard those images on resume. */
export function resumedContent(blocks: TurnBlock[]): TurnBlock[] {
  let reference = false;
  return blocks.filter((block) => {
    if (block.type === "text") {
      if (block.text.startsWith("<reference_evidence ")) reference = true;
      if (block.text === "</reference_evidence>") reference = false;
      return true;
    }
    return block.type !== "image" || reference;
  });
}

/**
 * The program's reply across the loop, as a chat with it would show it: propose_actions' message if it
 * sent one; otherwise its last words (what it wrote after its last tool call). What it says between tool
 * calls is narration, shown live while it works.
 */
export class ReplyCollector {
  private segments: string[][] = [[]];
  private proposed = false;
  constructor(private onLive?: (text: string) => void) {}
  text(text: string) {
    const trimmed = text.trim();
    if (!trimmed || this.proposed) return;
    this.segments.at(-1)!.push(trimmed);
    this.onLive?.(plainText(this.segments.at(-1)!.join("\n\n")));
  }
  tool(name: string) {
    if (name === "propose_actions" || name.endsWith("__propose_actions")) this.proposed = true;
    else if (this.segments.at(-1)!.length) this.segments.push([]);
  }
  reply(proposedMessage: string | null | undefined): string {
    const last = [...this.segments].reverse().find((s) => s.length);
    return plainText(proposedMessage || (last ? last.join("\n\n") : ""));
  }
}

/** Commands that destroy, publish or reconfigure: asked even under «Ejecución automática». */
const DESTRUCTIVE = /\b(rm\s+-[a-z]*[rf]|rmdir\s+\/s|del\s+\/[sqf]|rd\s+\/s|Remove-Item\b[^|;\n]*-(Recurse|Force)|format\s+[a-z]:|git\s+(push|reset\s+--hard|clean\s+-[a-z]*f)|shutdown|Stop-Computer|Restart-Computer|reg\s+(add|delete)|Set-ExecutionPolicy|Invoke-Expression|iex\b|npm\s+(publish|(i|install)\s+-g)|winget\s+(install|uninstall)|choco\s+(install|uninstall))\b|\|\s*(sh|bash|iex)\b/i;

function inside(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(/*turbopackIgnore: true*/ root, target));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Under «Ejecución automática» the program's own tools run without asking, except what reaches outside the
 * project or cannot be undone: writing a file elsewhere on the computer, or a destructive command.
 */
export function mustAskEvenInAuto(name: string, input: Record<string, unknown> | undefined, workspace: string): boolean {
  const s = (key: string) => (typeof input?.[key] === "string" ? String(input[key]) : "");
  switch (name) {
    case "Write": case "Edit": case "MultiEdit": case "NotebookEdit": {
      const file = s("file_path") || s("notebook_path");
      return !file || !inside(workspace, file);
    }
    case "Bash": case "PowerShell":
      return DESTRUCTIVE.test(s("command"));
    default:
      return false;
  }
}

/**
 * The command inside its wrappers: `rtk proxy …` (a user's token filter) and a shell started to run it
 * (`powershell -NoProfile -Command "…"`, `bash -lc '…'`), however they are nested.
 */
function unwrapShell(command: string): string {
  let text = command.trim();
  for (let i = 0; i < 4; i++) {
    const before = text;
    text = text.replace(/^rtk\s+proxy\s+/i, "");
    const shell = /^(?:"[^"]*?(?:pwsh|powershell|bash|zsh|sh|cmd)(?:\.exe)?"|[^"\s]*?(?:pwsh|powershell|bash|zsh|sh|cmd)(?:\.exe)?)\s+(?:(?:-NoProfile|-NonInteractive|-NoLogo)\s+|-ExecutionPolicy\s+\S+\s+)*(?:-Command|-lc|-c|\/c)\s+([\s\S]+)$/i.exec(text);
    if (shell) text = shell[1].trim().replace(/^(["'])([\s\S]*)\1$/, "$2").trim();
    if (text === before) break;
  }
  return text;
}

/** Commands that only look (read, list, search, probe media): never worth a question to the user. */
const READ_ONLY_VERBS = new Set([
  "get-content", "gc", "cat", "type", "get-childitem", "gci", "ls", "dir", "select-string", "sls", "rg", "grep", "findstr",
  "test-path", "get-item", "resolve-path", "measure-object", "select-object", "sort-object", "format-list", "format-table",
  "head", "tail", "wc", "pwd", "get-location", "ffprobe", "ffprobe.exe", "where", "where.exe", "which",
]);

/** ffmpeg options that take no value; every other option consumes the next word. */
const FFMPEG_FLAGS = new Set(["-y", "-n", "-hide_banner", "-nostats", "-stats", "-nostdin", "-an", "-vn", "-sn", "-dn", "-re", "-shortest", "-copyts", "-benchmark"]);

/** The agent's scratch folder inside the project (`agent/tmp/…`), written relative to the project folder. */
const SCRATCH = /^agent[\\/]tmp[\\/](?!(?:.*[\\/])?\.\.(?:[\\/]|$))[^"'<>|*?:]+$/i;

/**
 * ffmpeg that only looks: it measures (scene changes, blur, loudness, signalstats…) into the null muxer
 * and prints to the console, or it writes frames and strips into the agent's scratch folder.
 */
function ffmpegLooksOnly(piece: string): boolean {
  if (/\bfile=(?!-(?:[:,'"\s]|$))|-vstats_file\b|-passlogfile\b|-dump_attachment\b|-report\b/i.test(piece)) return false;
  const words = [...piece.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]).slice(1);
  const outputs: string[] = [];
  let format = "";
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (word.startsWith("-") && word !== "-") {
      if (FFMPEG_FLAGS.has(word.toLowerCase())) continue;
      const value = words[i + 1] ?? "";
      if (word === "-f") format = value;
      // A file name taken as an option's value could be an output after a flag this list doesn't know.
      if (word !== "-i" && /\.(mp4|mov|mkv|webm|avi|mp3|wav|m4a|aac|flac|jpe?g|png|gif|webp|txt|json|log|csv|srt)$/i.test(value)) return false;
      i++;
      continue;
    }
    outputs.push(word);
  }
  if (format === "null" && outputs.length === 1 && /^(-|NUL|\/dev\/null)$/i.test(outputs[0])) return true;
  return outputs.length > 0 && outputs.every((output) => SCRATCH.test(output));
}

/** HyperFrames orders that only look at a composition: they read it, check it or photograph it into its own folder. */
const HYPERFRAMES_LOOKS = new Set(["lint", "check", "snapshot", "catalog", "info", "compositions", "docs"]);
/** Options that write somewhere else, send frames to a service or download a model: those are the user's to allow. */
const HYPERFRAMES_ASKS = /^(?:-o|-out|-output-dir|--output|--describe|--on-device|-y|--yes|--human-friendly)(?:=|$)/i;
/** Options of those orders that take no value; any other option consumes the next word. */
const HYPERFRAMES_FLAGS = new Set([
  "--json", "--strict", "--verbose", "--lint-verbose", "--include-unmounted", "--snapshots", "--cache", "--no-cache", "--at-transitions",
  "--contrast", "--no-contrast", "--craft", "--no-craft", "--collapse-static", "--no-collapse-static", "--prepare-media", "--proxy", "--no-proxy",
  "--browser-gpu", "--no-browser-gpu", "--frame-check", "--review", "--end", "--no-end", "--keep",
]);

/** The same file, however the shell writes it (`C:\x`, `C:/x`, `/c/x`). */
function samePath(a: string, b: string): boolean {
  const plain = (file: string) => {
    const text = file.replace(/\\/g, "/").replace(/^\/([a-z])\//i, "$1:/");
    return process.platform === "win32" ? text.toLowerCase() : text;
  };
  return plain(a) === plain(b);
}

/**
 * The studio's own HyperFrames (its Node and its CLI, by their exact paths, which are outside the project)
 * on an order that only looks, at a folder below the current one.
 */
function hyperframesLooksOnly(piece: string): boolean {
  let studio: { node: string; cli: string };
  try { studio = hyperframesCommand(); } catch { return false; }
  const words = [...piece.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
  if (words.length < 3 || !samePath(words[0], studio.node) || !samePath(words[1], studio.cli) || !HYPERFRAMES_LOOKS.has(words[2])) return false;
  const rest = words.slice(3);
  if (rest.some((word) => HYPERFRAMES_ASKS.test(word))) return false;
  let places = 0;
  for (let i = 0; i < rest.length; i++) {
    const word = rest[i];
    if (word.startsWith("-")) {
      if (!word.includes("=") && !HYPERFRAMES_FLAGS.has(word.toLowerCase())) i++;
      continue;
    }
    // The folder to look at (or the words of a catalogue search): relative, and never upwards.
    if (/^[a-z]:|^[\\/~]|(?:^|[\\/])\.\.(?:[\\/]|$)/i.test(word)) return false;
    places++;
  }
  return words[2] === "catalog" || words[2] === "docs" || places <= 1;
}

/**
 * Whether a shell command only reads: every piece of it (split on ; && || |) starts with a read-only verb
 * (or is an ffmpeg measurement, or the studio's HyperFrames checking a composition), and nothing writes
 * (no redirection, no Set-Content / Out-File / -OutFile).
 */
export function isReadOnlyCommand(command: string): boolean {
  const text = unwrapShell(command).replace(/\s2>(?:&1|\s*(?:\$null|NUL|\/dev\/null))(?=\s|$)/gi, " ");
  if (!text || /[>]|\bSet-Content\b|\bAdd-Content\b|\bOut-File\b|-OutFile\b|\btee\b|`|\$\(/i.test(text)) return false;
  return text.split(/;|&&|\|\||\|/).every((piece) => {
    const clean = piece.trim().replace(/^rtk\s+proxy\s+/i, "").replace(/^&\s*/, "");
    // A second command can also follow a lone & (bash runs both) or a line break: only the first word is vetted, so those are asked.
    if (/[\r\n&]/.test(clean)) return false;
    const words = clean.match(/^"([^"]+)"|^'([^']+)'|^(\S+)/);
    const first = (words?.[1] ?? words?.[2] ?? words?.[3] ?? "").split(/[\\/]/).pop()?.toLowerCase() ?? "";
    if (first === "ffmpeg" || first === "ffmpeg.exe") return ffmpegLooksOnly(clean);
    return READ_ONLY_VERBS.has(first) || hyperframesLooksOnly(clean);
  });
}

/** The same rule for a command Codex reports as text. */
export function isDestructiveCommand(command: string): boolean {
  return DESTRUCTIVE.test(command);
}

export { inside as isInsideFolder };

/** What the chat asks the user when the program wants to use one of its own tools that needs permission. */
export function approvalRequest(name: string, input: Record<string, unknown> | undefined): ApprovalRequest {
  const s = (key: string) => (typeof input?.[key] === "string" ? String(input[key]) : "");
  switch (name) {
    case "Bash": case "PowerShell": return { title: "Ejecutar un comando", detail: s("command") || s("cmd") };
    case "Write": return { title: translate("Create or replace a file"), detail: s("file_path") };
    case "Edit": case "MultiEdit": case "NotebookEdit": return { title: translate("Edit a file"), detail: s("file_path") || s("notebook_path") };
    case "WebFetch": return { title: translate("Read a website"), detail: s("url") };
    default: return { title: translate("Use {0}", name), detail: JSON.stringify(input ?? {}).slice(0, 400) };
  }
}

/** Short words for one of the program's own tool calls, shown live and in the reply's action list. */
export function describeOwnTool(name: string, input: Record<string, unknown> | undefined): { label: string; record: boolean } {
  const s = (key: string) => (typeof input?.[key] === "string" ? String(input[key]) : "");
  const short = (text: string, max = 70) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
  const file = (p: string) => p.split(/[\\/]/).slice(-2).join("/");
  switch (name) {
    case "Bash": case "PowerShell": return { label: `Ejecutar: ${short(s("command"))}`, record: true };
    case "Read": return { label: `Leer ${file(s("file_path"))}`, record: false };
    case "Write": return { label: `Escribir ${file(s("file_path"))}`, record: true };
    case "Edit": case "MultiEdit": return { label: translate("Edit {0}", file(s("file_path"))), record: true };
    case "Glob": case "Grep": case "LS": return { label: translate("Search {0}", short(s("pattern") || s("path"), 40)), record: false };
    case "WebSearch": return { label: translate("Search on the web: {0}", short(s("query"), 50)), record: true };
    case "WebFetch": return { label: `Leer la web: ${short(s("url"), 50)}`, record: true };
    case "Skill": return { label: translate("Use the skill {0}", s("skill") || s("name")), record: true };
    case "Task": case "Agent": return { label: `Encargar: ${short(s("description"), 50)}`, record: true };
    case "TodoWrite": return { label: "Planificar los pasos", record: false };
    default: return { label: name, record: false };
  }
}

/**
 * The chat shows plain text, and the installed programs answer in Markdown by habit: drop emphasis marks,
 * headings, code ticks and link syntax, keep the words.
 */
export function plainText(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/(^|[\s(])\*(?!\s)([^*\n]+?)\*(?=[\s).,;:!?]|$)/g, "$1$2")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\[([^\]\n]+)\]\((?:[^)\s]+)\)/g, "$1")
    .replace(/^\s*[-*]\s+/gm, "• ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Twenty minutes: a turn with many tool calls takes a few; past this the program is stuck. */
export const TURN_TIMEOUT_MS = 20 * 60_000;

/**
 * A program's failure in words for the user, with what to do. Sign-in failures also drop the cached status
 * so Ajustes and the next turn check again.
 */
export function explainFailure(id: CliProviderId, raw: string, model = ""): Error {
  const label = AGENT_PROVIDER_INFO[id].label;
  const text = raw.replace(/\s+/g, " ").trim();
  if (/selected model|model[^.]{0,80}(does not exist|not exist|not found|not available|not supported)|unknown model|model_not_found|invalid model|do not have access to (it|the model)/i.test(text)) {
    const named = model ? `El modelo «${model}»` : "El modelo elegido";
    return new Error(translate("{0} does not exist in {1} or your account has no access. Change it or leave it empty in Settings › Agent.", named, label));
  }
  if (/not logged in|log ?in|\/login|unauthori[sz]ed|\b401\b|invalid api key|authentication|credential|token (has )?expired|oauth/i.test(text)) {
    forgetProviderStatus(id);
    return new Error(translate("{0} does not have the session started or has expired. {1} and try again.", label, SIGN_IN[id]));
  }
  if (/usage limit|rate.?limit|\b429\b|quota|limit reached|too many requests/i.test(text)) {
    return new Error(translate("You have reached the limit of use of your account in {0}. Wait for it to be renewed or choose another engine in Settings › Agent.", label));
  }
  if (/ENOENT|not recognized|no such file|cannot find/i.test(text)) {
    forgetProviderStatus(id);
    return new Error(translate("I can't find {0} on this computer. Check that it is installed in Settings › Agent.", label));
  }
  return new Error(`${label} ha fallado: ${text.slice(0, 400) || translate("without details")}`);
}

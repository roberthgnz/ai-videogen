import { t as translate, localizedLabels, getLocale } from "@/lib/i18n";
import { AGENT_PROVIDERS, AGENT_PROVIDER_INFO, type AgentProviderId, type AgentProviderStatus, type CliProviderId } from "@/lib/app-settings-shared";
import { env } from "@/lib/env";
import type { Locale } from "@/lib/i18n/locale";
import { findExecutable, runToEnd } from "./process";

/**
 * Which AI programs can run the agent on this computer: installed, their version, and whether the user is
 * signed in. Each check starts the program, so results are kept for a minute (the studio page polls).
 */

export interface DetectedProvider extends AgentProviderStatus {
  /** Full path of the program, for the CLI providers once found. */
  path: string | null;
}

const TTL_MS = 60_000;
interface Entry {
  locale: Locale;
  /** When the latest check started. */
  at: number;
  /** The latest check, maybe still running. */
  running: Promise<DetectedProvider>;
  /** The latest finished result. */
  last: DetectedProvider | null;
}
const globalForCli = globalThis as unknown as { __videogenAgentCli?: Map<AgentProviderId, Entry> };
const cache = (globalForCli.__videogenAgentCli ??= new Map());

/**
 * The status of one provider; `fresh` waits for a new check (the «Comprobar de nuevo» button). Otherwise a
 * known result comes back at once, and an old one is refreshed behind it, so the polled studio page never
 * waits on a program.
 */
export function providerStatus(id: AgentProviderId, fresh = false): Promise<DetectedProvider> {
  const cached = cache.get(id);
  const entry = cached?.locale === getLocale() ? cached : undefined;
  if (fresh || !entry) return check(id, entry).running;
  if (Date.now() - entry.at >= TTL_MS) check(id, entry);
  return entry.last ? Promise.resolve(entry.last) : entry.running;
}

function check(id: AgentProviderId, previous: Entry | undefined): Entry {
  const running = detect(id).catch((error): DetectedProvider => ({
    id, path: null, state: "error", detail: "",
    problem: translate("I couldn't check {0}: {1}", AGENT_PROVIDER_INFO[id].label, error instanceof Error ? error.message : String(error)),
  }));
  const entry: Entry = { locale: getLocale(), at: Date.now(), running, last: previous?.last ?? null };
  cache.set(id, entry);
  void running.then((value) => { entry.last = value; });
  return entry;
}

export function allProviderStatuses(fresh = false): Promise<DetectedProvider[]> {
  return Promise.all(AGENT_PROVIDERS.map((id) => providerStatus(id, fresh)));
}

/** Forgets a result, so the next turn or page checks again (after a sign-in error, say). */
export function forgetProviderStatus(id: AgentProviderId): void {
  cache.delete(id);
}

/** What the browser may see: no file paths. */
export function publicStatus({ id, state, detail, problem }: DetectedProvider): AgentProviderStatus {
  return { id, state, detail, problem };
}

function detect(id: AgentProviderId): Promise<DetectedProvider> {
  if (id === "anthropic") return Promise.resolve(detectAnthropic());
  return id === "claude-code" ? detectClaudeCode() : detectCodex();
}

function detectAnthropic(): DetectedProvider {
  const e = env();
  if (e.ANTHROPIC_API_KEY) return { id: "anthropic", path: null, state: "ready", detail: `Modelo ${e.ANTHROPIC_MODEL}`, problem: null };
  const where = process.env.VIDEOGEN_DESKTOP === "1" ? translate("in Adjustments › Services › Manage keys") : "en .env.local (ANTHROPIC_API_KEY)";
  return {
    id: "anthropic", path: null, state: "signed-out", detail: translate("No key"),
    problem: translate("The Anthropic API key is missing. Add it {0} and reboot VideoGen, or choose Claude Code or Codex in Settings › Agent.", where),
  };
}

/** How to install each program, for the "not installed" message. */
const INSTALL: Record<CliProviderId, string> = localizedLabels((translate) => ({
  "claude-code": translate("Install it from https://claude.com/claude-code (or with \"npm install -g @ anthropic-ai / claude-code\")"),
  codex: translate("Install with \"npm install -g @ openai / codex\" (or from https://developers.openai.com/codex)"),
}));

/** How to sign in to each program, for the "signed out" message. */
export const SIGN_IN: Record<CliProviderId, string> = localizedLabels((translate) => ({
  "claude-code": translate("Open a terminal, run \"claude auth login\" (or \"claud\" and then / login)"),
  codex: "Abre una terminal, ejecuta «codex login»",
}));

function missing(id: CliProviderId): DetectedProvider {
  return {
    id, path: null, state: "missing", detail: "No instalado",
    problem: translate("{0} is not installed on this computer. {1} and press \"Check again.\"", AGENT_PROVIDER_INFO[id].label, INSTALL[id]),
  };
}

function signedOut(id: CliProviderId, file: string, version: string): DetectedProvider {
  return {
    id, path: file, state: "signed-out", detail: translate("{0} · no session", version),
    problem: translate("{0} is installed but does not have the session started. {1} and press \"Check again.\"", AGENT_PROVIDER_INFO[id].label, SIGN_IN[id]),
  };
}

/** "2.1.3" out of "2.1.3 (Claude Code)" or "codex-cli 0.46.0". */
async function versionOf(file: string): Promise<string> {
  const out = await runToEnd(file, ["--version"]);
  const version = /\d+\.\d+\.\d+[\w.-]*/.exec(`${out.stdout} ${out.stderr}`)?.[0];
  if (out.code !== 0 || !version) throw new Error(translate("\"--version\" has failed ({0}).", out.stderr.trim() || translate("code {0}", out.code)));
  return `v${version}`;
}

async function detectClaudeCode(): Promise<DetectedProvider> {
  const file = findExecutable("claude");
  if (!file) return missing("claude-code");
  const version = await versionOf(file);
  // `claude auth status` prints JSON: { loggedIn, authMethod, subscriptionType, … }. Older versions lack it.
  const out = await runToEnd(file, ["auth", "status", "--json"]).catch(() => null);
  let status: { loggedIn?: boolean; authMethod?: string; subscriptionType?: string; apiKeySource?: string } | null = null;
  try { status = out ? JSON.parse(out.stdout) : null; } catch { status = null; }
  if (!status || typeof status.loggedIn !== "boolean") {
    return { id: "claude-code", path: file, state: "ready", detail: translate("{0} I was unable to check the session", version), problem: null };
  }
  if (!status.loggedIn) return signedOut("claude-code", file, version);
  const account = status.authMethod === "claude.ai"
    ? translate("Claude's account {0}", status.subscriptionType ? ` (${status.subscriptionType})` : "")
    : /api.?key/i.test(`${status.authMethod} ${status.apiKeySource ?? ""}`) ? translate("API key") : (status.authMethod ?? translate("session"));
  return { id: "claude-code", path: file, state: "ready", detail: `${version} · ${account}`, problem: null };
}

async function detectCodex(): Promise<DetectedProvider> {
  const file = findExecutable("codex");
  if (!file) return missing("codex");
  const version = await versionOf(file);
  // `codex login status`: exit 0 and "Logged in using ChatGPT" / "… an API key"; otherwise "Not logged in".
  const out = await runToEnd(file, ["login", "status"]);
  const text = `${out.stdout}\n${out.stderr}`;
  if (out.code !== 0 || /not logged in/i.test(text)) return signedOut("codex", file, version);
  const account = /chatgpt/i.test(text) ? translate("ChatGPT account") : /api key/i.test(text) ? translate("API key") : translate("session");
  return { id: "codex", path: file, state: "ready", detail: `${version} · ${account}`, problem: null };
}

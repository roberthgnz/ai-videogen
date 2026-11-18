import { t as translate } from "@/lib/i18n";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Finding, starting and stopping the AI programs installed on this computer (`claude`, `codex`). */

const isWindows = process.platform === "win32";

/**
 * Where the installers put these programs, searched after PATH: a desktop app on macOS starts with a bare
 * PATH, and on Windows the native installers do not always add themselves to it.
 */
function installDirs(): string[] {
  const home = os.homedir();
  if (isWindows) {
    const roaming = process.env.APPDATA ?? path.join(home, "AppData", "Roaming");
    const local = process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
    return [
      path.join(home, ".local", "bin"),
      path.join(home, ".claude", "local"),
      path.join(roaming, "npm"),
      path.join(local, "Programs", "OpenAI", "Codex", "bin"),
      path.join(local, "pnpm"),
      path.join(home, ".bun", "bin"),
      path.join(home, "scoop", "shims"),
    ];
  }
  return [
    path.join(home, ".local", "bin"),
    path.join(home, ".claude", "local"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    path.join(home, ".npm-global", "bin"),
    path.join(home, ".bun", "bin"),
    path.join(home, ".volta", "bin"),
    path.join(home, "Library", "pnpm"),
  ];
}

/** The full path of a program, looked up like a shell would (PATH order, then the usual install folders), or null. */
export function findExecutable(name: string): string | null {
  const dirs = [...(process.env.PATH ?? "").split(path.delimiter), ...installDirs()].filter(Boolean);
  // On Windows a bare file (npm also writes a shell script next to the .cmd) cannot be started.
  const exts = isWindows ? [".exe", ".cmd", ".bat"] : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(/*turbopackIgnore: true*/ dir, name + ext);
      try {
        const stat = fs.statSync(candidate);
        if (!stat.isFile()) continue;
        if (!isWindows) fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch { /* not here */ }
    }
  }
  return null;
}

/**
 * What the program's terminal inherits for the HyperFrames commands it runs while writing a composition: no
 * update notices, no usage telemetry in the user's name, and no skills installed by `init` (the studio
 * supplies them).
 */
const HYPERFRAMES_ENV = { HYPERFRAMES_NO_UPDATE_CHECK: "1", HYPERFRAMES_NO_TELEMETRY: "1", HYPERFRAMES_SKIP_SKILLS: "1" };

/**
 * The environment for a child program. A dev server started from a Claude Code terminal carries its
 * markers, and with them `claude` refuses to start ("cannot be launched inside another session").
 */
export function cliEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...HYPERFRAMES_ENV, ...extra };
  for (const key of ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT", "CLAUDE_AGENT_SDK_VERSION"]) delete env[key];
  // The app's own Anthropic key (.env.local, or the desktop's key store) is for the «API de Anthropic»
  // engine; with it in the environment Claude Code would bill that key instead of the user's own account.
  delete env.ANTHROPIC_API_KEY;
  return { ...env, ...extra };
}

/** Quotes one argument for cmd.exe. Arguments here are flags, plain values and file paths: never quotes or line breaks. */
function cmdArg(arg: string): string {
  if (/["\r\n%]/.test(arg)) throw new Error(translate("Unadmitted charge for a .cmd: {0}", arg));
  return arg === "" || /[\s&|<>^(),;=!]/.test(arg) ? `"${arg}"` : arg;
}

/**
 * Starts a program with pipes on stdin/stdout/stderr. npm installs a `.cmd` launcher on Windows, which Node
 * only runs through a shell (since CVE-2024-27980); long or structured input therefore travels in files or
 * on stdin, never on the command line.
 */
export function startProgram(file: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): ChildProcess {
  const base = { cwd: options.cwd, env: options.env ?? cliEnv(), windowsHide: true, stdio: "pipe" as const };
  if (isWindows && /\.(cmd|bat)$/i.test(file)) return spawn(`"${file}"`, args.map(cmdArg), { ...base, shell: true });
  return spawn(file, args, base);
}

/** Stops a program and whatever it started (a `.cmd` launcher sits between us and the real process). */
export function stopProgram(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  if (isWindows) {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    killer.on("error", () => child.kill());
  } else {
    child.kill("SIGTERM");
  }
}

export interface ProgramOutput {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs a short command to the end (version, sign-in status) and returns what it printed. Rejects if it cannot start. */
export function runToEnd(file: string, args: string[], timeoutMs = 15_000): Promise<ProgramOutput> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = startProgram(file, args);
    } catch (error) {
      reject(error);
      return;
    }
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      stopProgram(child);
      reject(new Error(`«${path.basename(file)} ${args.join(" ")}» no ha respondido en ${Math.round(timeoutMs / 1000)} s.`));
    }, timeoutMs);
    child.stdin?.end();
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

/** Calls `onLine` for every complete line a stream writes (the programs speak newline-delimited JSON). */
export function eachLine(stream: NodeJS.ReadableStream | null | undefined, onLine: (line: string) => void): void {
  if (!stream) return;
  let buffer = "";
  stream.on("data", (chunk: Buffer | string) => {
    buffer += chunk.toString();
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) onLine(line);
      newline = buffer.indexOf("\n");
    }
  });
  stream.on("end", () => {
    const line = buffer.trim();
    buffer = "";
    if (line) onLine(line);
  });
}

/**
 * Deletes a turn's scratch folder. On Windows the folder stays locked until the program we just stopped has
 * really exited (taskkill is asynchronous), so the removal is retried for a few seconds.
 */
export async function removeScratch(dir: string): Promise<void> {
  await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 500 }).catch((error) => {
    console.warn(translate("[agent-cli] could not be deleted {0}:", dir), error instanceof Error ? error.message : error);
  });
}

/** The last lines of what a program wrote to stderr, for an error message. */
export function tail(text: string, lines = 6): string {
  return text.trim().split(/\r?\n/).slice(-lines).join(" ").slice(0, 600);
}

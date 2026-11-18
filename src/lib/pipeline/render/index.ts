import { t as translate } from "@/lib/i18n";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { PipelineError } from "../errors";
import { hyperframesCli, runtimeBinary } from "../../runtime";

export type RenderQuality = "draft" | "looks" | "delivery";

export interface RenderProgress {
  /** HyperFrames stage code: compile, extract_video, process_audio, start_browsers, capture, encode, assemble, done. */
  stage: string;
  /** 0-100. */
  percent: number;
  done?: number;
  total?: number;
}

export interface RenderRequest {
  /** HyperFrames project directory (index.html at its root). */
  projectDir: string;
  /** Absolute path of the MP4 to write. */
  outFile: string;
  quality?: RenderQuality;
  onProgress?: (progress: RenderProgress) => void;
  signal?: AbortSignal;
}

export interface RenderResult {
  outFile: string;
  /** Tail of the renderer output. */
  log: string;
}

/**
 * Render step: HyperFrames project -> MP4. Implementations: the local CLI
 * today; a render queue or a cloud renderer later.
 */
export interface Renderer {
  readonly name: string;
  render(request: RenderRequest): Promise<RenderResult>;
}

const LOG_LINES = 200;

/** Parses one `@hf-progress {...}` line from the HyperFrames CLI, or null. */
export function parseProgressLine(line: string): RenderProgress | null {
  const match = /^@hf-progress\s+(\{.*\})\s*$/.exec(line.trim());
  if (!match) return null;
  try {
    const json = JSON.parse(match[1]) as { code?: string; pct?: number; done?: number; total?: number };
    if (typeof json.pct !== "number") return null;
    return { stage: json.code ?? "render", percent: json.pct, done: json.done, total: json.total };
  } catch {
    return null;
  }
}

/** Short, readable reason from the CLI output of a failed render. */
export function failureSummary(lines: string[]): string {
  const relevant = lines.filter((l) => /✗|Fix:|Error|error:|failed/i.test(l) && !l.startsWith("@hf-progress"));
  const picked = (relevant.length ? relevant : lines).slice(-6).map((l) => l.trim()).filter(Boolean);
  return picked.join("\n").slice(0, 1500);
}

/** Runs the project's pinned HyperFrames CLI in a child process. */
export class HyperFramesCliRenderer implements Renderer {
  readonly name = "hyperframes-cli";

  constructor(private readonly cliPath: string = defaultCliPath()) {}

  render(request: RenderRequest): Promise<RenderResult> {
    const { projectDir, outFile, quality = "looks", onProgress, signal } = request;
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    const args = [this.cliPath, "render", projectDir, "--output", outFile, "--quality", quality];

    return new Promise((resolve, reject) => {
      const child = spawn(runtimeBinary("VIDEOGEN_NODE_PATH", process.execPath), args, {
        cwd: projectDir,
        windowsHide: true,
        env: { ...process.env, HYPERFRAMES_NO_UPDATE_CHECK: "1", FORCE_COLOR: "0", NO_COLOR: "1" },
      });
      const lines: string[] = [];
      const push = (line: string) => {
        lines.push(line);
        if (lines.length > LOG_LINES) lines.shift();
      };

      const onAbort = () => child.kill();
      signal?.addEventListener("abort", onAbort, { once: true });

      let buffer = "";
      const onData = (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        const parts = buffer.split(/\r?\n/);
        buffer = parts.pop() ?? "";
        for (const raw of parts) {
          const line = raw.replace(/\u001b\[[0-9;]*m/g, "");
          const progress = parseProgressLine(line);
          if (progress) onProgress?.(progress);
          else if (line.trim() && !line.includes("[Render:trace]")) push(line);
        }
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);

      child.on("error", (error) => {
        signal?.removeEventListener("abort", onAbort);
        reject(new PipelineError("render", translate("HyperFrames could not be launched: {0}", error.message), { cause: error }));
      });
      child.on("close", (code) => {
        signal?.removeEventListener("abort", onAbort);
        if (buffer.trim()) push(buffer);
        const log = lines.join("\n");
        if (signal?.aborted) return reject(new PipelineError("render", translate("Render canceled.")));
        if (code !== 0) {
          return reject(
            new PipelineError("render", translate("HyperFrames finished with code {0}:\n{1}", code, failureSummary(lines)), {
              retryable: true,
            }),
          );
        }
        if (!fs.existsSync(outFile) || fs.statSync(outFile).size === 0) {
          return reject(new PipelineError("render", translate("HyperFrames didn't generate the MP4.\n{0}", failureSummary(lines))));
        }
        onProgress?.({ stage: "done", percent: 100 });
        resolve({ outFile, log });
      });
    });
  }
}

function defaultCliPath(): string {
  return hyperframesCli();
}

export function getRenderer(): Renderer {
  return new HyperFramesCliRenderer();
}

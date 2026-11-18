import { t as translate } from "@/lib/i18n";
import { execFile } from "node:child_process";
import { runtimeBinary } from "../runtime";

function ffmpegBin(): string {
  return runtimeBinary("FFMPEG_PATH", "ffmpeg");
}

/** Runs ffmpeg and returns its stderr (where it prints measurements). Throws a short, readable error. */
export function runFfmpeg(args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(/*turbopackIgnore: true*/ ffmpegBin(), args, { windowsHide: true, signal, maxBuffer: 8 * 1024 * 1024 }, (error, _stdout, stderr) => {
      if (!error) return resolve(stderr);
      const e = error as NodeJS.ErrnoException;
      if (e.code === "ENOENT") return reject(new Error(translate("No ffmpeg was found in the PATH (or in FFMPEG_PATH).")));
      reject(new Error(stderr.trim().split(/\r?\n/).slice(-3).join(" ") || e.message));
    });
  });
}

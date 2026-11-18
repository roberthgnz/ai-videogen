import { t as translate } from "@/lib/i18n";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runtimeBinary } from "../runtime";

const run = promisify(execFile);

export interface MediaStream {
  type: string;
  codec: string;
  width?: number;
  height?: number;
  durationSec?: number;
}

export interface MediaInfo {
  durationSec: number;
  streams: MediaStream[];
}

function ffprobeBin(): string {
  return runtimeBinary("FFPROBE_PATH", "ffprobe");
}

/** Container duration and streams of a media file, via ffprobe. */
export async function probeMedia(file: string, allowStill = false): Promise<MediaInfo> {
  let stdout: string;
  try {
    ({ stdout } = await run(
      ffprobeBin(),
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration:stream=codec_type,codec_name,width,height,duration",
        "-of",
        "json",
        file,
      ],
      { windowsHide: true, maxBuffer: 1024 * 1024 },
    ));
  } catch (error) {
    const e = error as NodeJS.ErrnoException & { stderr?: string };
    if (e.code === "ENOENT") throw new Error(translate("No ffprobe was found in the PATH (or in FFPROBE_PATH)."));
    throw new Error(translate("ffprobe failed with {0}: {1}", file, e.stderr?.trim() || e.message));
  }

  const json = JSON.parse(stdout) as {
    format?: { duration?: string };
    streams?: { codec_type: string; codec_name: string; width?: number; height?: number; duration?: string }[];
  };
  const durationSec = Number(json.format?.duration ?? (allowStill ? 0 : undefined));
  if (!Number.isFinite(durationSec)) throw new Error(translate("ffprobe did not return duration for {0}", file));
  return {
    durationSec,
    streams: (json.streams ?? []).map((s) => ({
      type: s.codec_type,
      codec: s.codec_name,
      width: s.width,
      height: s.height,
      durationSec: s.duration !== undefined ? Number(s.duration) : undefined,
    })),
  };
}

export async function probeDuration(file: string): Promise<number> {
  return (await probeMedia(file)).durationSec;
}

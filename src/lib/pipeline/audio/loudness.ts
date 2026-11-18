import { t as translate } from "@/lib/i18n";
import fs from "node:fs";
import path from "node:path";
import { runFfmpeg } from "@/lib/media/ffmpeg";

export interface LoudnessTarget {
  /** Integrated loudness, LUFS. */
  lufs: number;
  /** True-peak ceiling, dBTP. */
  truePeakDb: number;
}

export interface Loudness {
  /** Integrated loudness, LUFS. */
  lufs: number;
  /** True peak, dBTP. */
  truePeakDb: number;
  /** Loudness range, LU. */
  range: number;
  threshold: number;
  offset: number;
}

/** What a mix with no signal at all measures. */
const SILENCE_LUFS = -120;

/** Reads the JSON block ffmpeg's loudnorm filter prints at the end of its log. Exported for tests. */
export function parseLoudnorm(log: string): Loudness {
  const start = log.lastIndexOf("{");
  const end = log.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error(translate("ffmpeg did not return the volume measurement."));
  const json = JSON.parse(log.slice(start, end + 1)) as Record<string, string>;
  const num = (key: string) => {
    // Digital silence is reported as "-inf" (and an unusable offset as "inf"): treat it as the floor, not as an error.
    if (json[key] === "-inf") return SILENCE_LUFS;
    if (json[key] === "inf") return key === "target_offset" ? 0 : -SILENCE_LUFS;
    const value = Number(json[key]);
    if (!Number.isFinite(value)) throw new Error(translate("Invalid volume measurement ({0} = {1}).", key, json[key]));
    return value;
  };
  return {
    lufs: num("input_i"),
    truePeakDb: num("input_tp"),
    range: num("input_lra"),
    threshold: num("input_thresh"),
    offset: num("target_offset"),
  };
}

/** Measures a file's programme loudness (EBU R128) without writing anything. */
export async function measureLoudness(file: string, target: LoudnessTarget, signal?: AbortSignal): Promise<Loudness> {
  const log = await runFfmpeg(
    ["-hide_banner", "-nostats", "-i", file, "-vn", "-af", `loudnorm=I=${target.lufs}:TP=${target.truePeakDb}:LRA=11:print_format=json`, "-f", "null", "-"],
    signal,
  );
  return parseLoudnorm(log);
}

export interface NormalizeOptions {
  /** Mixes quieter than this (LUFS) count as silent and are not touched. */
  silentBelow?: number;
  /** Largest boost to apply (dB); the result may end up below the target. */
  maxGainDb?: number;
}

/**
 * Brings a rendered MP4 to the target loudness in place: measure, then apply
 * the exact gain (two-pass loudnorm) while copying the video stream untouched.
 * Returns what the file measures afterwards.
 */
export async function normalizeLoudness(
  file: string,
  target: LoudnessTarget,
  signal?: AbortSignal,
  options: NormalizeOptions = {},
): Promise<Loudness> {
  const before = await measureLoudness(file, target, signal);
  // Audio that is practically silent (an intentionally muted montage) is left alone: boosting it would only raise noise.
  if (options.silentBelow !== undefined && before.lufs < options.silentBelow) return before;
  // A cap on the boost keeps a very quiet mix from being amplified to the target at any cost.
  const lufs = options.maxGainDb === undefined ? target.lufs : Math.min(target.lufs, before.lufs + options.maxGainDb);
  const filter =
    `loudnorm=I=${lufs}:TP=${target.truePeakDb}:LRA=11` +
    `:measured_I=${before.lufs}:measured_TP=${before.truePeakDb}:measured_LRA=${before.range}` +
    `:measured_thresh=${before.threshold}:offset=${before.offset}:linear=true`;
  const partial = path.join(path.dirname(file), `normalizing-${path.basename(file)}`);
  try {
    await runFfmpeg(
      ["-v", "error", "-y", "-i", file, "-map", "0:v:0", "-map", "0:a:0", "-c:v", "copy", "-af", filter, "-ar", "48000", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", partial],
      signal,
    );
    fs.renameSync(partial, file);
  } finally {
    fs.rmSync(partial, { force: true });
  }
  return measureLoudness(file, target, signal);
}

import fs from "node:fs/promises";
import path from "node:path";
import { runFfmpeg } from "@/lib/media/ffmpeg";
import { ensureDir, resolveInStorage, storagePaths } from "@/lib/storage";
import type { EditAsset } from "./schema";
import type { AudioEnergy } from "./transcript";

/**
 * Silence measured on the audio. A fixed threshold misses the pauses of a loud recording and takes the
 * quiet words of a soft one for silence; the threshold follows the recording's own level instead.
 */

/** dB under which a recording counts as silent: its mean level less 18 dB, within -50…-32 dB. */
export async function noiseFloor(file: string): Promise<number> {
  try {
    const log = await runFfmpeg(["-i", file, "-vn", "-af", "volumedetect", "-f", "null", "-"]);
    const mean = Number(/mean_volume:\s*(-?[\d.]+) dB/.exec(log)?.[1]);
    return Number.isFinite(mean) ? Math.max(-50, Math.min(-32, Math.round(mean - 18))) : -35;
  } catch {
    return -35;
  }
}

/** Quiet stretches of at least `minSeconds`, in seconds of the file. */
export async function quietStretches(file: string, minSeconds = 0.3): Promise<{ from: number; to: number }[]> {
  const floor = await noiseFloor(file);
  const log = await runFfmpeg(["-i", file, "-vn", "-af", `silencedetect=noise=${floor}dB:d=${minSeconds}`, "-f", "null", "-"]);
  const out: { from: number; to: number }[] = [];
  let start: number | null = null;
  for (const m of log.matchAll(/silence_(start|end):\s*(-?[\d.]+)/g)) {
    if (m[1] === "start") start = Math.max(0, Number(m[2]));
    else if (start !== null) {
      out.push({ from: start, to: Number(m[2]) });
      start = null;
    }
  }
  return out;
}

/**
 * The level envelope of a file, every 20 ms: what places a cut exactly where a word ends or starts (the
 * transcription's word edges can be off by a tenth of a second, and it stretches words over silences).
 */
export async function audioEnergy(file: string, scratch: string): Promise<AudioEnergy> {
  const rate = 8000, step = 0.02, window = rate * step;
  try {
    await runFfmpeg(["-v", "error", "-y", "-i", file, "-vn", "-ac", "1", "-ar", String(rate), "-f", "s16le", scratch]);
    const raw = await fs.readFile(scratch);
    // Int16Array needs an even offset into its buffer.
    const pcm = raw.byteOffset % 2 ? Buffer.from(raw) : raw;
    const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 2));
    const db: number[] = [];
    for (let at = 0; at < samples.length; at += window) {
      let sum = 0;
      const end = Math.min(samples.length, at + window);
      for (let k = at; k < end; k++) sum += samples[k] * samples[k];
      const rms = Math.sqrt(sum / Math.max(1, end - at)) / 32768;
      db.push(rms > 0 ? Math.max(-100, Math.round(20 * Math.log10(rms))) : -100);
    }
    return { step, db, quiet: quietLevel(db) };
  } finally {
    await fs.rm(scratch, { force: true });
  }
}

/** Between the recording's quiet (10th percentile) and its speech (90th): a third of the way up, at least 10 dB under speech. */
export function quietLevel(db: number[]): number {
  if (!db.length) return -45;
  const sorted = [...db].sort((a, b) => a - b);
  const low = sorted[Math.floor(sorted.length * 0.1)], high = sorted[Math.floor(sorted.length * 0.9)];
  return Math.round(Math.min(high - 10, Math.max(low + 6, low + (high - low) / 3)));
}

/** The level envelope of a file of a project (see audioEnergy), measured once and cached with its other analyses. */
export async function cachedEnergy(projectId: string, asset: Pick<EditAsset, "id" | "path">): Promise<AudioEnergy> {
  const dir = ensureDir(path.join(storagePaths.project(projectId), "analysis"));
  const cacheFile = path.join(dir, `energy-${asset.id}.json`);
  try {
    const cached = JSON.parse(await fs.readFile(cacheFile, "utf8")) as AudioEnergy;
    if (cached.step > 0 && Array.isArray(cached.db) && typeof cached.quiet === "number") return cached;
  } catch { /* Not measured yet. */ }
  const energy = await audioEnergy(resolveInStorage(asset.path), path.join(dir, `energy-${asset.id}-${crypto.randomUUID()}.pcm`));
  await fs.writeFile(cacheFile, JSON.stringify(energy));
  return energy;
}

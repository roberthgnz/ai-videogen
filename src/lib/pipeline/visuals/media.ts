import { t as translate } from "@/lib/i18n";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { FORMAT_SIZE, type VideoFormat, type VisualCandidate, type VisualFile } from "@/lib/domain";
import { runFfmpeg } from "@/lib/media/ffmpeg";
import { probeMedia } from "@/lib/media/ffprobe";
import { storagePaths } from "@/lib/storage";
import { PipelineError } from "../errors";

/** Length of every normalized clip: the longest shot (4 s) plus room for transitions. */
export const CLIP_SEC = 6;
/** Videos shorter than this cannot fill a shot. */
export const MIN_SOURCE_SEC = CLIP_SEC;
/** A normalized clip must at least cover the longest shot. */
const MIN_USABLE_SEC = 4.2;
/** Renditions above this are skipped unless nothing else exists (4K files run to ~100 MB). */
const MAX_DOWNLOAD_BYTES = 60 * 1024 * 1024;

/**
 * The rendition to download: the smallest one that fills the frame without
 * upscaling, else the sharpest one of a reasonable size.
 */
export function pickFile(candidate: VisualCandidate, format: VideoFormat): VisualFile {
  const { width, height } = FORMAT_SIZE[format];
  const coverScale = (f: VisualFile) => Math.max(width / f.width, height / f.height);
  const files = [...candidate.files].sort((a, b) => a.width * a.height - b.width * b.height);
  const affordable = files.filter((f) => (f.size ?? 0) <= MAX_DOWNLOAD_BYTES);
  const pool = affordable.length ? affordable : files.slice(0, 1);
  return pool.find((f) => coverScale(f) <= 1) ?? pool.at(-1)!;
}

/** How much the chosen rendition must be enlarged to fill the frame (1 or less = none). */
export function upscale(candidate: VisualCandidate, format: VideoFormat): number {
  const { width, height } = FORMAT_SIZE[format];
  const file = pickFile(candidate, format);
  return Math.max(width / file.width, height / file.height);
}

/** Where the normalized file of a candidate lives (it may not exist yet). */
export function shotFilePath(candidate: Pick<VisualCandidate, "provider" | "id" | "kind">, format: VideoFormat): string {
  const { width, height } = FORMAT_SIZE[format];
  const safe = `${candidate.provider}-${candidate.id}`.replace(/[^\w.-]/g, "_");
  return path.join(storagePaths.mediaCache(), `${safe}-${width}x${height}.${candidate.kind === "video" ? "mp4" : "jpg"}`);
}

export function hasShotFile(candidate: VisualCandidate, format: VideoFormat): boolean {
  return fs.existsSync(shotFilePath(candidate, format));
}

/** ffmpeg arguments that turn a source into the normalized clip or still. Exported for tests. */
export function normalizeArgs(candidate: VisualCandidate, source: string, format: VideoFormat, outFile: string): string[] {
  const { width, height } = FORMAT_SIZE[format];
  const cover = `scale=${width}:${height}:force_original_aspect_ratio=increase:flags=lanczos,crop=${width}:${height}`;
  const input = ["-v", "error", "-y"];
  if (candidate.kind === "image") {
    return [...input, "-i", source, "-frames:v", "1", "-vf", cover, "-q:v", "3", outFile];
  }
  // Skip the first moments (stock clips often open on a fade or a shaky start).
  const spare = Math.max(0, (candidate.durationSec ?? CLIP_SEC) - CLIP_SEC);
  const offset = Math.min(3, spare / 3);
  return [
    ...input,
    "-ss", offset.toFixed(2),
    "-t", String(CLIP_SEC),
    "-i", source,
    "-an",
    "-vf", `${cover},fps=30,format=yuv420p`,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
    // A keyframe every second keeps frame-accurate seeking cheap for the renderer.
    "-g", "30",
    "-movflags", "+faststart",
    outFile,
  ];
}

// One job per output file, even when two scenes use the same asset.
const inFlight = new Map<string, Promise<string>>();

/** Streams a remote file to disk. (ffmpeg reading the URL directly fails on some CDN files.) */
async function download(url: string, file: string, signal?: AbortSignal): Promise<void> {
  const response = await fetch(url, { signal });
  if (!response.ok || !response.body) throw new Error(`descarga ${response.status} ${response.statusText}`.trim());
  await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), fs.createWriteStream(file));
}

/**
 * Makes sure the candidate exists on disk cropped to the frame (videos also
 * trimmed to CLIP_SEC, 30 fps, no audio) and returns its path.
 */
export function ensureShotFile(candidate: VisualCandidate, format: VideoFormat, signal?: AbortSignal): Promise<string> {
  const outFile = shotFilePath(candidate, format);
  if (fs.existsSync(outFile)) return Promise.resolve(outFile);
  const running = inFlight.get(outFile);
  if (running) return running;

  const job = (async () => {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    const partial = `${outFile}.part${path.extname(outFile)}`;
    const source = `${outFile}.src`;
    try {
      await download(pickFile(candidate, format).url, source, signal);
      await runFfmpeg(normalizeArgs(candidate, source, format, partial), signal);
      // ffmpeg can exit 0 with an empty file: trust only what ffprobe measures.
      const info = await probeMedia(partial);
      const video = info.streams.find((s) => s.type === "video");
      const { width, height } = FORMAT_SIZE[format];
      if (!video || video.width !== width || video.height !== height) throw new Error(translate("the standard file is not valid."));
      if (candidate.kind === "video" && info.durationSec < MIN_USABLE_SEC) {
        throw new Error(`el clip solo dura ${info.durationSec.toFixed(1)} s.`);
      }
      fs.renameSync(partial, outFile);
      return outFile;
    } catch (error) {
      fs.rmSync(partial, { force: true });
      throw new PipelineError(
        "visuals",
        translate("It was not possible to download {0} {1} {2}: {3}", candidate.kind === "video" ? translate("the video") : translate("the image"), candidate.provider, candidate.id, error instanceof Error ? error.message : error),
        { retryable: true, cause: error },
      );
    }
  })().finally(() => {
    fs.rmSync(`${outFile}.src`, { force: true });
    inFlight.delete(outFile);
  });
  inFlight.set(outFile, job);
  return job;
}

import { t as translate } from "@/lib/i18n";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { getProject } from "@/lib/projects";
import { ensureDir, resolveInStorage, storagePaths, toStorageRelative } from "@/lib/storage";
import { probeMedia } from "@/lib/media/ffprobe";
import { runFfmpeg } from "@/lib/media/ffmpeg";
import { warmOverview } from "./overview";
import { warmFootage } from "./footage";
import { placeAsset } from "./place";
import { saveEditDocument } from "./repository";
import { overlaySchema, parseSubtitles, type EditAsset, type EditDocument } from "./schema";
import { cachedEnergy, noiseFloor } from "./silence";
import { captionWordsPerCue, retimeWords, sourceCaptions, type WordTiming } from "./transcript";
import { transcriptWordsSchema } from "./transcript-schema";
import { MAX_UPLOAD_BYTES } from "./upload";
import { hyperframesCli, runtimeBinary } from "../runtime";
import { registerGlobalAsset } from "../global-assets";

const exec = promisify(execFile);
export { MAX_UPLOAD_BYTES } from "./upload";
const video = new Set([".mp4", ".mov", ".m4v", ".webm", ".mkv"]);
const audio = new Set([".mp3", ".wav", ".m4a", ".ogg", ".flac", ".aac"]);
const images = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const documents = new Set([".txt", ".md", ".json", ".csv"]);

/** `place`: also put the file on the timeline (after what is there; audio as music), as the multi-file import does. */
export async function importMedia(projectId: string, file: File, options: { place?: boolean } = {}): Promise<EditDocument> {
  if (!getProject(projectId)) throw new Error(translate("Project not found."));
  if (!file.size || file.size > MAX_UPLOAD_BYTES) throw new Error(translate("The file must be between 1 byte and 256 MB."));
  const ext = path.extname(file.name).toLowerCase();
  const kind = video.has(ext) ? "video" : audio.has(ext) ? "audio" : images.has(ext) ? "image" : documents.has(ext) ? "document" : null;
  if (!kind) throw new Error(translate("Unadmitted format. Use video, audio, PNG / JPG / WebP or TXT / MD / JSON / CSV documents."));
  if (kind === "document" && file.size > 1024 * 1024) throw new Error("Los documentos pueden ocupar hasta 1 MB.");
  const id = crypto.randomUUID();
  const dir = ensureDir(path.join(storagePaths.project(projectId), "media", id));
  const original = path.join(dir, `source${ext}`);
  const output = path.join(dir, kind === "video" ? "media.mp4" : kind === "audio" ? "media.mp3" : kind === "image" ? "media.png" : "document.txt");
  try {
    await fs.writeFile(original, Buffer.from(await file.arrayBuffer()));
    let info = { durationSec: 0, streams: [] } as Awaited<ReturnType<typeof probeMedia>>;
    let context = "";
    if (kind === "document") {
      context = (await file.text()).slice(0, 16000);
      await fs.writeFile(output, context);
    } else {
      info = await probeMedia(original, kind === "image");
      if (kind !== "image" && (info.durationSec <= 0 || info.durationSec > 7200)) throw new Error(translate("The maximum duration is two hours."));
      if (kind === "video" && !info.streams.some((s) => s.type === "video")) throw new Error(translate("The file does not contain video."));
      if (kind === "audio" && !info.streams.some((s) => s.type === "audio")) throw new Error(translate("The file does not contain audio."));
      const filter = "scale=w='min(1920,iw)':h='min(1920,ih)':force_original_aspect_ratio=decrease,pad=ceil(iw/2)*2:ceil(ih/2)*2";
      await runFfmpeg(["-y", "-i", original, ...(kind === "video" ? ["-map", "0:v:0", "-map", "0:a:0?", "-vf", filter, "-c:v", "libx264", "-preset", "fast", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart"]
        : kind === "audio" ? ["-vn", "-c:a", "libmp3lame", "-q:a", "2"] : ["-vf", filter, "-frames:v", "1"]), output]);
      info = await probeMedia(output, kind === "image");
    }
    const stream = info.streams.find((s) => s.type === "video");
    const asset: EditAsset = { id, name: file.name.slice(0, 240), kind, path: toStorageRelative(output), duration: info.durationSec,
      width: stream?.width ?? 0, height: stream?.height ?? 0, hasAudio: info.streams.some((s) => s.type === "audio"), context };
    const fresh = getProject(projectId)!;
    const withAsset = { ...fresh.edit, enabled: true, assets: [...fresh.edit.assets, asset] };
    const saved = saveEditDocument(projectId, options.place ? placeAsset(withAsset, asset) : withAsset, true);
    registerGlobalAsset({
      id: asset.id,
      name: asset.name,
      kind: asset.kind,
      source: "upload",
      path: asset.path,
      duration: asset.duration,
      width: stream?.width ?? 0,
      height: stream?.height ?? 0,
      hasAudio: asset.hasAudio,
      context: asset.context,
      projectId,
    });
    await fs.unlink(original).catch(() => {});
    warmOverview(projectId, asset);
    warmFootage(projectId, asset);
    return saved;
  } catch (error) {
    // The only directory removed is the UUID created above, inside this project's media folder.
    await fs.rm(dir, { recursive: true, force: true });
    throw error;
  }
}

async function cli(args: string[]) {
  const cliPath = hyperframesCli();
  try {
    return (await exec(runtimeBinary("VIDEOGEN_NODE_PATH", process.execPath), [cliPath, ...args], { windowsHide: true, timeout: 20 * 60 * 1000, maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, HYPERFRAMES_NO_UPDATE_CHECK: "1", NO_COLOR: "1" } })).stdout;
  } catch (e) {
    const error = e as Error & { stderr?: string };
    throw new Error((error.stderr || error.message).slice(-1800));
  }
}

export async function analyzeMedia(projectId: string, assetId: string, operation: "transcribe" | "silences" | "beats") {
  const p = getProject(projectId);
  const asset = p?.edit.assets.find((a) => a.id === assetId);
  if (!asset || !asset.hasAudio) throw new Error(translate("Select a project file with audio."));
  const file = resolveInStorage(asset.path);
  if (operation === "silences") return { log: await runFfmpeg(["-i", file, "-af", `silencedetect=noise=${await noiseFloor(file)}dB:d=0.45`, "-f", "null", "-"]) };
  if (operation === "beats") {
    // A track's beats never change: analyse it once.
    const cacheFile = path.join(ensureDir(path.join(storagePaths.project(projectId), "analysis")), `beats-${asset.id}.json`);
    try {
      return JSON.parse(await fs.readFile(cacheFile, "utf8")) as { beats: number[]; bpm: number | null };
    } catch { /* Not analysed yet. */ }
    const output = await cli(["beats", file, "--json"]);
    const result = JSON.parse(output.slice(output.indexOf("{"))) as { beatTimes: number[]; bpm: number | null };
    if (!result.beatTimes?.length) throw new Error(translate("A stable rhythm was not detected in this audio."));
    const beats = { beats: result.beatTimes, bpm: result.bpm };
    await fs.writeFile(cacheFile, JSON.stringify(beats));
    return beats;
  }
  const cacheFile = transcriptCachePath(projectId, asset.id);
  // Subtitles come from the words, grouped as the voice-over's are and with the project's dictionary of names.
  const corrections = p?.edit.transcript?.corrections ?? [], perCue = p ? captionWordsPerCue(p.edit) : 4;
  try {
    const cached = JSON.parse(await fs.readFile(cacheFile, "utf8")) as { captions?: unknown; words?: unknown; retimed?: boolean };
    const words = transcriptWordsSchema.safeParse(cached.words);
    if (words.success && words.data.length) {
      const checked = cached.retimed ? words.data : await checkTimings(projectId, asset, words.data);
      if (!cached.retimed) await fs.writeFile(cacheFile, JSON.stringify({ captions: cached.captions, words: checked, retimed: true }));
      return { captions: sourceCaptions(checked, corrections, perCue), words: checked };
    }
    // Cached before word timings were kept («words» missing): transcribed again below, once.
    const captions = z.array(overlaySchema).min(1).safeParse(cached.captions);
    if (captions.success && cached.words === null) return { captions: captions.data, words: null };
  } catch { /* No successful transcription cached yet. */ }
  const dir = ensureDir(path.join(storagePaths.project(projectId), "analysis", crypto.randomUUID()));
  const srt = path.join(dir, "subtitles.srt");
  await cli(["transcribe", file, "--dir", dir, "--model", "small", "--to", "srt", "--output", srt, "--json"]);
  // HyperFrames writes the word timings next to the subtitles: they are what transcript editing works on.
  const timed = transcriptWordsSchema.safeParse(await fs.readFile(path.join(dir, "transcript.json"), "utf8").then(JSON.parse).catch(() => null));
  const words = timed.success && timed.data.length ? await checkTimings(projectId, asset, timed.data) : null;
  const result = { captions: words ? sourceCaptions(words, corrections, perCue) : parseSubtitles(await fs.readFile(srt, "utf8")), words };
  await fs.writeFile(cacheFile, JSON.stringify({ captions: result.captions, words, retimed: true }));
  return result;
}

/** Word timings checked against the file's audio level (see retimeWords); as given if it cannot be measured. */
async function checkTimings(projectId: string, asset: EditAsset, words: WordTiming[]): Promise<WordTiming[]> {
  return retimeWords(words, await cachedEnergy(projectId, asset).catch(() => undefined));
}

/** Where a file's transcription (subtitles and word timings, in seconds of the file) is cached. */
export function transcriptCachePath(projectId: string, assetId: string): string {
  return path.join(ensureDir(path.join(storagePaths.project(projectId), "analysis")), `transcript-${assetId}.json`);
}

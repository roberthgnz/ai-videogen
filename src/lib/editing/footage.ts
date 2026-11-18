import { languageName, t as translate } from "@/lib/i18n";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { env } from "@/lib/env";
import { runFfmpeg } from "@/lib/media/ffmpeg";
import { getProject } from "@/lib/projects";
import { runtimeBinary } from "@/lib/runtime";
import { ensureDir, resolveInStorage, storagePaths } from "@/lib/storage";
import { captureTimeFromName, orderClips, segmentMoments, type FootageClip, type Moment, type MotionSample } from "./footage-plan";
import { referenceAssetIds, type EditAsset, type EditDocument } from "./schema";
import { xstackOffset } from "./overview";

/**
 * The seeing half of the editing harness: what each clip contains, moment by moment. Motion comes from ffmpeg,
 * the words from one vision request per clip; both are cached next to the project, since imported files never
 * change. Without an Anthropic key the log still has every moment and its times, just no descriptions.
 */

const VERSION = 1;
const MAX_CLIPS = 24;
const MAX_MOMENTS_DESCRIBED = 14;
const exec = promisify(execFile);

interface CachedClip extends Omit<FootageClip, "label" | "reference"> { version: number; described: boolean }

const dirOf = (projectId: string) => ensureDir(path.join(storagePaths.project(projectId), "footage"));
const keyframeFile = (projectId: string, assetId: string, index: number) => path.join(dirOf(projectId), `${assetId}-${index}.jpg`);

/** Frame-to-frame change four times a second: the camera moving, a cut, or stillness. */
async function motionSamples(file: string): Promise<MotionSample[]> {
  const log = await runFfmpeg(["-hide_banner", "-nostats", "-i", file, "-an", "-vf", "fps=4,scale=160:-2,select='gte(scene,0)',metadata=print:key=lavfi.scene_score", "-f", "null", "-"]);
  const samples: MotionSample[] = [];
  let t: number | null = null;
  for (const line of log.split(/\r?\n/)) {
    const time = line.match(/pts_time:\s*([\d.]+)/);
    if (time) { t = Number(time[1]); continue; }
    const score = line.match(/lavfi\.scene_score=([\d.]+)/);
    if (score && t !== null) { samples.push({ t, score: Number(score[1]) }); t = null; }
  }
  return samples;
}

/** The filming time the camera wrote into the file, if any. */
async function creationTime(file: string): Promise<number | null> {
  try {
    const { stdout } = await exec(runtimeBinary("FFPROBE_PATH", "ffprobe"), ["-v", "error", "-show_entries", "format_tags=creation_time", "-of", "default=nw=1:nk=1", file], { windowsHide: true });
    const ms = Date.parse(stdout.trim());
    // Encoders stamp "now" or 1970 when there was nothing: only trust plausible camera dates.
    return Number.isFinite(ms) && ms > Date.UTC(2005, 0, 1) && ms < Date.now() - 60_000 ? ms : null;
  } catch { return null; }
}

async function extractFrame(file: string, t: number, out: string, width = 512) {
  await runFfmpeg(["-v", "error", "-y", "-ss", String(Math.max(0, t)), "-i", file, "-frames:v", "1", "-vf", `scale=${width}:-2`, "-q:v", "4", out]);
}

const descriptionSchema = z.object({
  summary: z.string().describe("What the clip as a whole shows, a sentence"),
  moments: z.array(z.object({
    id: z.string(),
    description: z.string().describe("Subject, action and frame in 6-18 words, concrete (what hand, what object, what happens)"),
    visibleText: z.string().describe("Legable text or numbers in the image; empty if there is no"),
    quality: z.enum(["buena", "movida", "borrosa", "oscura", "tapada"]),
  })),
});

/** One vision request per clip: the keyframe of each moment, described as an editor would log it. */
async function describe(clip: { label: string; name: string; duration: number; kind: string }, moments: Moment[], frames: string[]): Promise<{ summary: string; moments: Map<string, Pick<Moment, "description" | "visibleText" | "quality">> } | null> {
  if (!env().ANTHROPIC_API_KEY) return null;
  const client = new Anthropic({ apiKey: env().ANTHROPIC_API_KEY });
  const content: Anthropic.Beta.BetaContentBlockParam[] = [{ type: "text", text: translate("Clip {0} \"{1} ', {2}. One frame for a moment, in order:", clip.label, clip.name, clip.kind === "image" ? "imagen" : `${clip.duration.toFixed(1)} s`) }];
  moments.forEach((m, i) => {
    content.push({ type: "text", text: `${m.id} (${m.from.toFixed(1)}–${m.to.toFixed(1)} s)` });
    content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: frames[i] } });
  });
  content.push({ type: "text", text: `Log each moment from the perspective of an editor arranging footage for a short video. Describe what is visible, the stage of the action (beginning, in progress, or finished), any legible numbers or signs that establish order, and image quality. Write concise descriptions in ${languageName()}. Return one item per input ID with the original IDs.` });
  try {
    const response = await client.beta.messages.parse({
      model: env().ANTHROPIC_MODEL,
      max_tokens: 8000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low", format: betaZodOutputFormat(descriptionSchema) },
      messages: [{ role: "user", content }],
    });
    if (response.stop_reason === "refusal" || !response.parsed_output) return null;
    const out = response.parsed_output;
    return { summary: out.summary, moments: new Map(out.moments.map((m) => [m.id.toUpperCase(), { description: m.description, visibleText: m.visibleText.trim() || undefined, quality: m.quality }])) };
  } catch (error) {
    console.error(`[footage] describe ${clip.name}:`, error);
    return null;
  }
}

/** Analyses running in this process: an import's warm-up and the agent's first turn share one, never pay twice. */
const globalForFootage = globalThis as unknown as { __videogenFootage?: Map<string, Promise<CachedClip>> };
const inflight = (globalForFootage.__videogenFootage ??= new Map());

function clipLog(projectId: string, asset: EditAsset, label: string): Promise<CachedClip> {
  const key = `${projectId}:${asset.id}`;
  const running = inflight.get(key);
  if (running) return running;
  const task = analyseClip(projectId, asset, label).finally(() => inflight.delete(key));
  inflight.set(key, task);
  return task;
}

/** One clip's log: from the cache, or analysed now (motion, moments, keyframes, then the vision pass). */
async function analyseClip(projectId: string, asset: EditAsset, label: string): Promise<CachedClip> {
  const jsonFile = path.join(dirOf(projectId), `${asset.id}.json`);
  try {
    const cached = JSON.parse(await fs.readFile(jsonFile, "utf8")) as CachedClip;
    // A log made without descriptions (no key at the time) is described as soon as a key is there.
    if (cached.version === VERSION && (cached.described || !env().ANTHROPIC_API_KEY)) return cached;
  } catch { /* Not analysed yet. */ }

  const file = resolveInStorage(asset.path);
  const kind = asset.kind === "image" ? "image" : "video";
  // A timestamp in the name (phones, WhatsApp) is exact and stable; the container tag can be the send time.
  const capturedAt = captureTimeFromName(asset.name) ?? (await creationTime(file));
  const ranges = kind === "image"
    ? [{ from: 0, to: 0, best: 0, motion: 0 }]
    : segmentMoments(asset.duration, await motionSamples(file).catch(() => []));
  let moments: Moment[] = ranges.map((r, i) => ({ id: `M${i + 1}`, assetId: asset.id, ...r }));
  const frames: string[] = [];
  for (const [i, m] of moments.entries()) {
    const out = keyframeFile(projectId, asset.id, i);
    try { await extractFrame(file, m.best, out); frames.push((await fs.readFile(out)).toString("base64")); }
    catch { frames.push(""); }
  }
  // Ids carry the clip's label at read time (the label depends on the other clips), so the cache keeps "M<n>".
  const sample = moments.map((m, i) => ({ m, i })).filter(({ i }) => frames[i]).slice(0, MAX_MOMENTS_DESCRIBED);
  const described = sample.length ? await describe({ label, name: asset.name, duration: asset.duration, kind },
    sample.map(({ m }) => ({ ...m, id: `${label}.${m.id}` })), sample.map(({ i }) => frames[i])) : null;
  if (described) moments = moments.map((m) => ({ ...m, ...(described.moments.get(`${label}.${m.id}`.toUpperCase()) ?? {}) }));
  const log: CachedClip = { version: VERSION, described: !!described, assetId: asset.id, name: asset.name, kind, duration: asset.duration, capturedAt, summary: described?.summary, moments };
  await fs.writeFile(jsonFile, JSON.stringify(log));
  return log;
}

/**
 * Logs a clip whose content is already known (stock b-roll picked for a search) as one moment with that
 * description, so no vision request is spent on it. A clip that already has a log keeps it.
 */
export async function seedFootage(projectId: string, asset: EditAsset, description: string): Promise<void> {
  if (asset.kind !== "video" && asset.kind !== "image") return;
  const jsonFile = path.join(dirOf(projectId), `${asset.id}.json`);
  try { await fs.access(jsonFile); return; } catch { /* Not logged yet. */ }
  const to = asset.kind === "image" ? 0 : asset.duration;
  const log: CachedClip = { version: VERSION, described: true, assetId: asset.id, name: asset.name, kind: asset.kind, duration: asset.duration, capturedAt: null, summary: description,
    moments: [{ id: "M1", assetId: asset.id, from: 0, to, best: to / 2, motion: 0, description }] };
  await fs.writeFile(jsonFile, JSON.stringify(log));
}

/** Analyses a new clip in the background right after import, so the first edit does not wait for it. */
export function warmFootage(projectId: string, asset: EditAsset): void {
  if (asset.kind !== "video" && asset.kind !== "image") return;
  void clipLog(projectId, asset, "C?").catch(() => undefined);
}

/**
 * The project's footage log: every video and image in filming order (C1, C2…; references R1…), split into
 * moments with what happens in each. Moment ids are "C3.M2". Computed in parallel and cached.
 */
export async function footageLog(projectId: string, doc?: EditDocument): Promise<FootageClip[]> {
  const edit = doc ?? getProject(projectId)?.edit;
  if (!edit) return [];
  const guides = referenceAssetIds(edit);
  const assets = edit.assets.filter((a) => a.kind === "video" || a.kind === "image").slice(0, MAX_CLIPS);
  // Labels first (they only need names and times), so the vision pass already names moments as the agent will.
  const pre = orderClips(assets.map((a) => ({ assetId: a.id, name: a.name, capturedAt: captureTimeFromName(a.name), reference: guides.has(a.id) })));
  const labelOf = new Map(pre.map((c) => [c.assetId, c.label]));
  const results: CachedClip[] = [];
  let next = 0;
  const worker = async () => {
    while (next < assets.length) {
      const asset = assets[next++];
      try { results.push(await clipLog(projectId, asset, labelOf.get(asset.id) ?? "C?")); } catch (error) { console.error(`[footage] ${asset.name}:`, error); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, assets.length) }, worker));
  return orderClips(results.map((c) => ({ ...c, reference: guides.has(c.assetId) }))).map((c) => ({
    label: c.label, assetId: c.assetId, name: c.name, kind: c.kind, duration: c.duration, capturedAt: c.capturedAt, reference: c.reference, summary: c.summary,
    moments: c.moments.map((m) => ({ ...m, id: `${c.label}.${m.id.replace(/^.*\./, "")}` })),
  }));
}

export interface StripFrame { file: string; t: number }

/**
 * Frames side by side in one JPEG (base64), in reading order, every cell the same size: a filmstrip of a cut or of
 * a stretch of a clip. Vertical and horizontal sources are letterboxed into the same cell.
 */
export async function filmstrip(frames: StripFrame[], options: { vertical: boolean; cols?: number; cellWidth?: number }): Promise<string | null> {
  if (!frames.length) return null;
  const base = options.vertical ? [144, 256] : [256, 144];
  const w = options.cellWidth ? Math.max(128, Math.min(640, Math.round(options.cellWidth / 2) * 2)) : base[0];
  const h = Math.round((base[1] / base[0]) * w / 2) * 2;
  const cols = Math.min(frames.length, options.cols ?? (options.vertical ? 8 : 5));
  const tmp = path.join(os.tmpdir(), `videogen-strip-${crypto.randomUUID()}.jpg`);
  // Seeking a single-frame image, even to zero, can discard its only frame in FFmpeg.
  // Zero needs no seek for videos either; keep the input's first frame intact.
  const inputs = frames.flatMap((f) => [...(f.t > 0 ? ["-ss", String(f.t)] : []), "-i", f.file]);
  const cells = frames.map((_, k) => `[${k}:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[f${k}]`).join(";");
  const layout = frames.map((_, k) => `${xstackOffset(k % cols, "w0")}_${xstackOffset(Math.floor(k / cols), "h0")}`).join("|");
  const filter = frames.length === 1 ? `${cells};[f0]null[out]` : `${cells};${frames.map((_, k) => `[f${k}]`).join("")}xstack=inputs=${frames.length}:layout=${layout}:fill=black[out]`;
  try {
    await runFfmpeg(["-v", "error", "-y", ...inputs, "-filter_complex", filter, "-map", "[out]", "-frames:v", "1", "-q:v", "5", tmp]);
    return (await fs.readFile(tmp)).toString("base64");
  } catch (error) {
    console.error("[footage] filmstrip:", error);
    return null;
  } finally {
    await fs.rm(tmp, { force: true });
  }
}

/** The picture clips of a montage as a filmstrip: one frame from the middle of each cut, numbered in the text. */
export async function cutFilmstrip(doc: EditDocument, vertical: boolean, limit = 32): Promise<{ image: string | null; lines: string[] }> {
  const picture = doc.clips
    .filter((c) => { const a = doc.assets.find((x) => x.id === c.assetId); return a && (a.kind === "video" || a.kind === "image") && (c.track ?? 0) === 0; })
    .sort((a, b) => a.start - b.start);
  // Long cuts: spread the frames evenly rather than dropping the end.
  const step = Math.max(1, Math.ceil(picture.length / limit));
  const shown = picture.filter((_, i) => i % step === 0);
  const frames = shown.map((c) => {
    const asset = doc.assets.find((a) => a.id === c.assetId)!;
    return { file: resolveInStorage(asset.path), t: asset.kind === "image" ? 0 : c.in + (c.duration * (c.speed ?? 1)) / 2 };
  });
  const lines = shown.map((c, i) => translate("{0}. {1} - {2} s · {3} from {4} s", i + 1, c.start.toFixed(1), (c.start + c.duration).toFixed(1), doc.assets.find((a) => a.id === c.assetId)?.name ?? "?", c.in.toFixed(1)));
  return { image: await filmstrip(frames, { vertical }), lines };
}

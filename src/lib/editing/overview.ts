import { t as translate } from "@/lib/i18n";
import fs from "node:fs/promises";
import path from "node:path";
import { runFfmpeg } from "@/lib/media/ffmpeg";
import { getProject } from "@/lib/projects";
import { ensureDir, resolveInStorage, storagePaths } from "@/lib/storage";
import type { EditAsset } from "./schema";

/** Most videos that get a contact sheet; the rest are listed by name and length only. */
export const MAX_OVERVIEWS = 14;
/** A shot change is a frame that differs from the previous one by more than this (ffmpeg "scene" score, 0-1). */
export const SCENE_THRESHOLD = 0.3;
/** Shot changes closer than this are one change (flashes, fast pans). */
const MIN_SHOT = 0.15;
const VERSION = 2;
const SHEET_WIDTH = 1024;

export interface AssetOverview {
  assetId: string;
  name: string;
  kind: "video" | "image";
  duration: number;
  /** Times (s) the frames of the sheet were taken at, left to right, top to bottom. */
  sheetTimes: number[];
  /** Base64 JPEG of the frames side by side, or null when it could not be made. */
  sheet: string | null;
  /** Times (s) where the picture changes shot. */
  shotChanges: number[];
}

/** How many frames a contact sheet of a clip of this length has: about one every 3 s, 4 to 9. */
export function sheetFrameCount(duration: number): number {
  return Math.max(4, Math.min(9, Math.round(duration / 3)));
}

/** The moments to sample: the middle of each of `count` equal slices (never the black first frame or the last one). */
export function sampleTimes(duration: number, count: number): number[] {
  return Array.from({ length: count }, (_, i) => Math.round(((i + 0.5) * duration) / count * 100) / 100);
}

/** Grid of the sheet: one row up to 5 frames, two above. */
export function sheetGrid(count: number): { cols: number; rows: number } {
  return count <= 5 ? { cols: count, rows: 1 } : { cols: Math.ceil(count / 2), rows: 2 };
}

/** An xstack coordinate: `n` steps of `unit` ("0" for the first), e.g. 2 steps of w0 = "w0+w0". */
export function xstackOffset(n: number, unit: "w0" | "h0"): string {
  return n === 0 ? "0" : Array(n).fill(unit).join("+");
}

/** Shot-change times from ffmpeg's `showinfo` output: merged when closer than MIN_SHOT, capped. */
export function parseShotChanges(log: string, duration: number): number[] {
  const times = [...log.matchAll(/pts_time:\s*([\d.]+)/g)].map((m) => Number(m[1])).filter((t) => t > 0.2 && t < duration - 0.2);
  const merged: number[] = [];
  for (const t of times) if (merged.length === 0 || t - merged[merged.length - 1] >= MIN_SHOT) merged.push(Math.round(t * 1000) / 1000);
  return merged;
}

async function build(projectId: string, asset: EditAsset): Promise<AssetOverview> {
  const kind = asset.kind === "image" ? "image" : "video";
  const file = resolveInStorage(asset.path);
  const dir = ensureDir(path.join(storagePaths.project(projectId), "overview"));
  const jsonFile = path.join(dir, `${asset.id}.json`);
  const sheetFile = path.join(dir, `${asset.id}.jpg`);
  // Assets never change after import, so what was computed once is good forever.
  try {
    const cached = JSON.parse(await fs.readFile(jsonFile, "utf8")) as Omit<AssetOverview, "sheet"> & { version: number };
    if (cached.version !== VERSION) throw new Error(translate("An overview prior to the complete analysis of cuts."));
    return { ...cached, sheet: (await fs.readFile(sheetFile)).toString("base64") };
  } catch { /* Not computed yet. */ }

  const count = kind === "image" ? 1 : sheetFrameCount(asset.duration);
  const times = kind === "image" ? [0] : sampleTimes(asset.duration, count);
  const { cols } = sheetGrid(count);
  const cellWidth = Math.floor(SHEET_WIDTH / cols);
  let sheet: string | null = null;
  try {
    // Frame k is the one at times[k]: one fast seek each, then tiled. All frames share a size, so xstack needs no padding.
    const inputs = times.flatMap((t) => ["-ss", String(t), "-i", file]);
    const scaled = times.map((_, k) => `[${k}:v]scale=${cellWidth}:-2,setsar=1[f${k}]`).join(";");
    // xstack positions: columns are sums of w0 (the width of the first frame), rows of h0.
    const layout = times.map((_, k) => `${xstackOffset(k % cols, "w0")}_${xstackOffset(Math.floor(k / cols), "h0")}`).join("|");
    const filter = count === 1
      ? `[0:v]scale=${SHEET_WIDTH}:-2:force_original_aspect_ratio=decrease[out]`
      : `${scaled};${times.map((_, k) => `[f${k}]`).join("")}xstack=inputs=${count}:layout=${layout}:fill=black[out]`;
    await runFfmpeg(["-v", "error", "-y", ...inputs, "-filter_complex", filter, "-map", "[out]", "-frames:v", "1", "-q:v", "5", sheetFile]);
    sheet = (await fs.readFile(sheetFile)).toString("base64");
  } catch { /* The overview still lists the shot changes; the model just cannot see this one. */ }

  let shotChanges: number[] = [];
  if (kind === "video") {
    try {
      const log = await runFfmpeg(["-hide_banner", "-nostats", "-i", file, "-an", "-vf", `select='gt(scene,${SCENE_THRESHOLD})',showinfo`, "-f", "null", "-"]);
      shotChanges = parseShotChanges(log, asset.duration);
    } catch { /* Same: optional. */ }
  }
  const overview: AssetOverview = { assetId: asset.id, name: asset.name, kind, duration: asset.duration, sheetTimes: times, sheet, shotChanges };
  if (sheet) await fs.writeFile(jsonFile, JSON.stringify({ ...overview, sheet: undefined, version: VERSION }));
  return overview;
}

/** Computes (and caches) one asset's overview in the background, right after it is imported, so the first request does not wait. */
export function warmOverview(projectId: string, asset: EditAsset): void {
  if (asset.kind !== "video" && asset.kind !== "image") return;
  void build(projectId, asset).catch(() => undefined);
}

/**
 * What the assistant needs to judge footage: for every video and image of the
 * project (up to MAX_OVERVIEWS), a contact sheet with frames spread over its
 * whole length and the times where the picture changes shot. Computed in
 * parallel, cached on disk.
 */
export async function assetOverviews(projectId: string): Promise<AssetOverview[]> {
  const project = getProject(projectId);
  if (!project) return [];
  const guides = new Set(project.edit.references.flatMap((r) => r.assetId ? [r.assetId] : []));
  const assets = project.edit.assets.filter((a) => a.kind === "video" || a.kind === "image")
    .sort((a, b) => Number(guides.has(b.id)) - Number(guides.has(a.id))).slice(0, MAX_OVERVIEWS);
  const results: AssetOverview[] = new Array(assets.length);
  let next = 0;
  const worker = async () => {
    while (next < assets.length) {
      const i = next++;
      try { results[i] = await build(projectId, assets[i]); } catch { /* One bad file must not blind the assistant to the rest. */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, assets.length) }, worker));
  return results.filter(Boolean);
}

/** The text that goes with an asset's contact sheet. */
export function describeOverview(o: AssetOverview): string {
  const frames = o.kind === "image" ? "imagen" : translate("frames to t = {0} s (left to right, top down)", o.sheetTimes.map((t) => `${t}`).join(", "));
  const shots = o.kind === "image" ? "" : o.shotChanges.length ? translate(" Flat changes in: {0} s.", o.shotChanges.join(", ")) : translate(" No clear plane changes (continuous plane).");
  return translate("File \"{0} '(id {1}), {2}: {3}. {4}", o.name, o.assetId, o.kind === "image" ? "imagen" : `${o.duration.toFixed(1)} s`, frames, shots);
}

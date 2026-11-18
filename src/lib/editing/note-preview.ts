import { t as translate } from "@/lib/i18n";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runFfmpeg } from "@/lib/media/ffmpeg";
import { resolveInStorage } from "@/lib/storage";
import { filmstrip } from "./footage";
import { clipFrame } from "./motion";
import { layeredClips } from "./timeline";
import { filterPath, previewFont, textBox, textWarnings } from "./text-preview";
import type { EditDocument } from "./schema";
import type { NoteChange } from "./notes";

/** A lightweight composition for reviewing notes: all visible layers, clip transforms and active texts.
 * Typography uses system fonts and estimated text boxes; this is not a pixel-exact export preview. */
async function snapshot(doc: EditDocument, vertical: boolean, at: number, targetIds: Set<string>, dir: string, signal?: AbortSignal): Promise<string> {
  const [width, height] = vertical ? [540, 960] : [960, 540];
  const scale = width / (vertical ? 1080 : 1920);
  const active = <T extends { start: number; duration: number }>(items: T[]) => items.filter((i) => i.start <= at && at < i.start + i.duration);
  const picture = active(layeredClips(doc)).flatMap((clip) => {
    const asset = doc.assets.find((a) => a.id === clip.assetId);
    return asset && (asset.kind === "video" || asset.kind === "image") ? [{ clip, asset }] : [];
  });
  // Refuse rather than silently omit a visible layer in an unusually dense composition.
  if (picture.length > 24) throw new Error(translate("There are more than 24 simultaneous visual layers; this light view cannot represent all of them."));
  const args = ["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=0x${doc.background.slice(1)}:s=${width}x${height}:r=30`];
  const filters: string[] = ["[0:v]format=rgba[base0]"];
  for (const [index, { clip, asset }] of picture.entries()) {
    const input = index + 1;
    if (asset.kind === "video") args.push("-ss", String(Math.max(0, clip.in + (at - clip.start) * (clip.speed ?? 1))));
    args.push("-i", resolveInStorage(asset.path));
    const fit = clip.fit === "contain"
      ? `scale=${width}:${height}:force_original_aspect_ratio=decrease,format=rgba,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black@0`
      : `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`;
    const frame = clipFrame(clip, at);
    const w = Math.ceil(width * frame.scale / 2) * 2, h = Math.ceil(height * frame.scale / 2) * 2;
    filters.push(`[${input}:v]${fit},scale=${w}:${h},setsar=1,setpts=PTS-STARTPTS,format=rgba,colorchannelmixer=aa=${frame.opacity}[media${input}]`);
    filters.push(`[base${index}][media${input}]overlay=x=(W-w)/2+${width * frame.x / 100}:y=(H-h)/2:shortest=1[base${input}]`);
  }
  const drawing: string[] = [];
  // Same order as the export: titles, then captions, preserving list order within each kind.
  const overlays = ["text", "caption"].flatMap((kind) => active(doc.overlays).filter((o) => o.kind === kind));
  for (const [index, overlay] of overlays.entries()) {
    const box = textBox(overlay, vertical);
    const x = Math.round(box.x * width / 100), y = Math.round(box.y * height / 100);
    const w = Math.max(1, Math.round(box.w * width / 100)), h = Math.max(1, Math.round(box.h * height / 100));
    const size = Math.max(8, Math.round(overlay.fontSize * scale));
    if (overlay.background !== "transparent") drawing.push(`drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=0x${overlay.background.slice(1)}:t=fill`);
    const font = previewFont(overlay);
    if (!font) throw new Error(translate("There is no local source to represent the texts of the review."));
    const textFile = path.join(dir, `text-${index}.txt`);
    // Approximate the canvas wrapping instead of drawing a long unwrapped line over neighbouring elements.
    const maxChars = Math.max(1, Math.floor(w / (size * 0.55)));
    const lines = overlay.text.split(/\r?\n/).flatMap((paragraph) => {
      const wrapped: string[] = []; let line = "";
      for (const word of paragraph.split(/\s+/).filter(Boolean)) {
        if (line && line.length + word.length + 1 > maxChars) { wrapped.push(line); line = word; }
        else line = line ? `${line} ${word}` : word;
      }
      return [...wrapped, line];
    });
    await fs.writeFile(textFile, lines.join("\n"));
    const textX = overlay.align === "left" ? String(x + size * 0.2)
      : overlay.align === "right" ? `${x + w - size * 0.2}-text_w` : `${x + w / 2}-text_w/2`;
    drawing.push(`drawtext=fontfile=${filterPath(font)}:textfile=${filterPath(textFile)}:expansion=none:fontsize=${size}:fontcolor=0x${overlay.color.slice(1)}:line_spacing=${Math.round(size * 0.25)}:x=${textX}:y=${y + size * 0.2}`);
    if (targetIds.has(overlay.id)) drawing.push(`drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=yellow@0.85:t=2`);
  }
  if (vertical) drawing.push(`drawbox=x=0:y=0:w=${width}:h=${height * 0.1}:color=red@0.16:t=fill`, `drawbox=x=0:y=${height * 0.8}:w=${width}:h=${height * 0.2}:color=red@0.16:t=fill`);
  const font = previewFont();
  if (font) drawing.push(`drawtext=fontfile=${filterPath(font)}:text='${at.toFixed(3)} s':fontsize=18:fontcolor=white:box=1:boxcolor=black@0.8:x=6:y=6`);
  filters.push(`[base${picture.length}]${drawing.length ? drawing.join(",") : "null"}[out]`);
  const out = path.join(dir, "frame.jpg");
  await runFfmpeg([...args, "-filter_complex", filters.join(";"), "-map", "[out]", "-frames:v", "1", "-q:v", "4", out], signal);
  return out;
}

export async function notePreviewPage(doc: EditDocument, vertical: boolean, times: number[], changes: NoteChange[], signal?: AbortSignal): Promise<{ image: string | null; failures: string[] }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "videogen-note-"));
  const failures: string[] = [];
  const frames: { file: string; t: number }[] = [];
  const targets = new Set(changes.map((c) => c.id));
  try {
    // Bound the number of concurrent decoders; each snapshot can itself contain several video inputs.
    for (const [index, time] of times.entries()) {
      signal?.throwIfAborted();
      try {
        const cell = path.join(dir, String(index));
        await fs.mkdir(cell);
        frames.push({ file: await snapshot(doc, vertical, time, targets, cell, signal), t: 0 });
      } catch (error) {
        signal?.throwIfAborted();
        failures.push(`${time.toFixed(3)} s: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const image = await filmstrip(frames, { vertical, cols: 3, cellWidth: vertical ? 300 : 480 });
    signal?.throwIfAborted();
    if (!image && frames.length) failures.push(translate("The review sheet could not be mounted."));
    return { image, failures };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** Numeric checks cover every changed text, including changes made through a bulk patch. */
export function noteWarnings(doc: EditDocument, changes: NoteChange[], vertical: boolean): string[] {
  const changedIds = new Set(changes.filter((c) => c.kind === "overlay").map((c) => c.id));
  const warnings: string[] = [];
  for (const overlay of doc.overlays.filter((o) => changedIds.has(o.id))) {
    warnings.push(...textWarnings(overlay, vertical).map((warning) => `${overlay.id}: ${warning}`));
    for (const other of doc.overlays) {
      if (other.id === overlay.id || other.start >= overlay.start + overlay.duration || overlay.start >= other.start + other.duration) continue;
      const a = textBox(overlay, vertical), b = textBox(other, vertical);
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) {
        warnings.push(translate("{0} coincides in time and space with {1}; check if they duplicate an idea or are plugged. Do not move the other text without the note justifying it.", overlay.id, other.id));
      }
    }
  }
  return [...new Set(warnings)];
}

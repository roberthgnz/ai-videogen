import { t as translate } from "@/lib/i18n";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runFfmpeg } from "@/lib/media/ffmpeg";
import { resolveInStorage } from "@/lib/storage";
import type { EditDocument, EditOverlay } from "./schema";

/**
 * What a text looks like on the montage: the frame under it at the moment it shows, the text itself in its
 * box, and the strips the social apps' interface covers. The agent sees it with place_text's result, so
 * every text it places is checked by eye, as its cuts are on the filmstrip.
 */

/** A bold system font for the preview (ffmpeg needs a TTF/OTF file); without one only the box is drawn. */
const FONTS = [
  "C:/Windows/Fonts/arialbd.ttf", "C:/Windows/Fonts/segoeuib.ttf",
  "/System/Library/Fonts/Supplemental/Arial Bold.ttf", "/Library/Fonts/Arial Bold.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf",
];
export function previewFont(overlay?: EditOverlay): string | null {
  const family = overlay?.fontFamily ?? "sans";
  const italic = overlay?.fontStyle === "italic";
  const bold = (overlay?.fontWeight ?? 700) >= 600;
  const suffix = bold ? (italic ? "bi" : "bd") : italic ? "i" : "";
  const windowsName = family === "serif" ? "georgia" : family === "mono" ? "cour" : "arial";
  // Georgia uses "b" rather than "bd" for bold.
  const windowsSuffix = family === "serif" && suffix === "bd" ? "b" : suffix;
  const linuxName = family === "serif" ? "Serif" : family === "mono" ? "Mono" : "Sans";
  const face = bold ? (italic ? "BoldItalic" : "Bold") : italic ? "Italic" : "Regular";
  const macName = family === "serif" ? "Georgia" : family === "mono" ? "Courier New" : "Arial";
  const macFace = [bold ? "Bold" : "", italic ? "Italic" : ""].filter(Boolean).join(" ");
  return [
    `C:/Windows/Fonts/${windowsName}${windowsSuffix}.ttf`,
    `/System/Library/Fonts/Supplemental/${macName}${macFace ? ` ${macFace}` : ""}.ttf`,
    `/usr/share/fonts/truetype/liberation2/Liberation${linuxName}-${face}.ttf`,
    ...FONTS,
  ].find((f) => fs.existsSync(f)) ?? null;
}

/** A path inside an ffmpeg filter: forward slashes, the drive colon escaped, quoted. */
export const filterPath = (p: string) => `'${p.replace(/\\/g, "/").replace(/:/g, "\\:")}'`;

/** The text broken into the lines the canvas would show at this width (an estimate: 0.55 em per character). */
function wrap(text: string, charsPerLine: number): string[] {
  return text.split(/\r?\n/).flatMap((paragraph) => {
    const lines: string[] = [];
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (line && (line.length + 1 + word.length) > charsPerLine) { lines.push(line); line = word; }
      else line = line ? `${line} ${word}` : word;
    }
    return [...lines, line];
  });
}

/** The box a text takes on the canvas, in % of width and height (height estimated from the wrapped lines). */
export function textBox(overlay: EditOverlay, vertical: boolean): { x: number; y: number; w: number; h: number; lines: number } {
  const canvasW = vertical ? 1080 : 1920;
  const canvasH = vertical ? 1920 : 1080;
  const boxW = (overlay.width / 100) * canvasW;
  const lines = wrap(overlay.text, Math.max(1, Math.floor(boxW / (0.55 * overlay.fontSize)))).length;
  const boxH = lines * overlay.fontSize * 1.25 + overlay.fontSize * 0.4;
  return { x: overlay.x, y: overlay.y, w: overlay.width, h: (boxH / canvasH) * 100, lines };
}

/**
 * What can be measured about a text without looking: outside the safe zone, out of frame, too long to
 * read, too short on screen. The picture (faces, the subject) is for the agent to judge on the preview.
 */
export function textWarnings(overlay: EditOverlay, vertical: boolean): string[] {
  const box = textBox(overlay, vertical);
  const words = overlay.text.split(/\s+/).filter(Boolean).length;
  const warnings: string[] = [];
  if (vertical && box.y < 10) warnings.push(translate("starts at {0}% of the high: the social network interface covers the top 10%; lower it at least to y = 10", box.y.toFixed(0)));
  if (vertical && box.y + box.h > 80) warnings.push(translate("ends at {0}% of the height: the interface covers the bottom 20%; upload or redeem it", (box.y + box.h).toFixed(0)));
  if (box.y + box.h > 100) warnings.push(translate("it gets out of the frame below"));
  if (box.x + box.w > 100) warnings.push(translate("it leaves the frame on the right"));
  if (words > 9 && overlay.kind !== "caption") warnings.push(translate("has {0} words: in a short video does not give time to read it; leave it in 6-7", words));
  if (box.lines > 3 && overlay.kind !== "caption") warnings.push(translate("occupies a {0} line: reduces text or size", box.lines));
  const minSeconds = Math.max(1.2, words * 0.3);
  if (overlay.duration < minSeconds && overlay.kind !== "caption") warnings.push(translate("hard {0} s and needs at least {1} s to be read", overlay.duration.toFixed(1), minSeconds.toFixed(1)));
  return warnings;
}

/** The preview as base64 JPEG, or null when it cannot be made (no picture under the text, ffmpeg missing). */
export async function textPreview(doc: EditDocument, overlay: EditOverlay, vertical: boolean): Promise<string | null> {
  const [W, H] = vertical ? [540, 960] : [960, 540];
  const k = W / (vertical ? 1080 : 1920); // fontSize is in pixels of the full-size canvas
  const t = overlay.start + Math.min(0.6, overlay.duration / 2);
  const clip = doc.clips
    .filter((c) => (c.track ?? 0) === 0 && c.start <= t && t < c.start + c.duration)
    .map((c) => ({ c, a: doc.assets.find((a) => a.id === c.assetId) }))
    .find(({ a }) => a && (a.kind === "video" || a.kind === "image"));

  const size = Math.max(8, overlay.fontSize * k);
  const box = { x: (overlay.x / 100) * W, y: (overlay.y / 100) * H, w: (overlay.width / 100) * W };
  const lines = wrap(overlay.text, Math.max(1, Math.floor(box.w / (0.55 * size))));
  const boxH = lines.length * size * 1.25 + size * 0.4;
  const font = previewFont(overlay);
  const id = crypto.randomUUID();
  const out = path.join(os.tmpdir(), `videogen-text-${id}.jpg`);
  const textFile = path.join(os.tmpdir(), `videogen-text-${id}.txt`);
  const px = (n: number) => Math.round(n);

  const base = clip?.a
    ? ["-ss", String(Math.max(0, clip.a.kind === "image" ? 0 : clip.c.in + (t - clip.c.start) * (clip.c.speed ?? 1))), "-i", resolveInStorage(clip.a.path)]
    : ["-f", "lavfi", "-i", `color=c=${(doc.background || "#000000").replace("#", "0x")}:s=${W}x${H}`];
  const fit = clip?.c.fit === "contain"
    ? `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black`
    : `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}`;
  const filters = [
    fit,
    // The strips the platforms' interface covers (vertical: top 10 %, bottom 20 %).
    ...(vertical ? [`drawbox=x=0:y=0:w=${W}:h=${px(H * 0.1)}:color=red@0.28:t=fill`, `drawbox=x=0:y=${px(H * 0.8)}:w=${W}:h=${px(H * 0.2)}:color=red@0.28:t=fill`] : []),
    ...(overlay.background !== "transparent" ? [`drawbox=x=${px(box.x)}:y=${px(box.y)}:w=${px(box.w)}:h=${px(boxH)}:color=${overlay.background.replace("#", "0x")}@0.9:t=fill`] : []),
    ...(font ? [`drawtext=fontfile=${filterPath(font)}:textfile=${filterPath(textFile)}:fontsize=${px(size)}:fontcolor=${overlay.color.replace("#", "0x")}:line_spacing=${px(size * 0.25)}:x=${overlay.align === "left" ? px(box.x + size * 0.2) : overlay.align === "right" ? `${px(box.x + box.w - size * 0.2)}-text_w` : `${px(box.x + box.w / 2)}-text_w/2`}:y=${px(box.y + size * 0.2)}:borderw=2:bordercolor=black@0.6`] : []),
    `drawbox=x=${px(box.x)}:y=${px(box.y)}:w=${px(box.w)}:h=${px(boxH)}:color=yellow@0.95:t=3`,
  ];
  try {
    fs.writeFileSync(textFile, lines.join("\n"));
    await runFfmpeg(["-v", "error", "-y", ...base, "-frames:v", "1", "-vf", filters.join(","), "-q:v", "5", out]);
    return fs.readFileSync(out).toString("base64");
  } catch (error) {
    console.error("[text-preview]", error);
    return null;
  } finally {
    fs.rmSync(out, { force: true });
    fs.rmSync(textFile, { force: true });
  }
}

/** Mean of a measure ffmpeg's signalstats prints for one frame (first value), or null. */
async function frameMean(input: string[], filters: string): Promise<number | null> {
  try {
    const log = await runFfmpeg(["-v", "info", ...input, "-frames:v", "1", "-vf", `${filters},signalstats,metadata=print:key=lavfi.signalstats.YAVG`, "-f", "null", "-"]);
    const value = /lavfi\.signalstats\.YAVG=([\d.]+)/.exec(log)?.[1];
    return value === undefined ? null : Number(value);
  } catch {
    return null;
  }
}

/** Relative luminance of a #rrggbb color on the 0-255 video scale. */
function luma(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/**
 * Measured on the real frame under a text: whether it will read (brightness under it against its color)
 * and whether it sits on the busiest part of the shot, where the subject usually is (edge density under
 * it against the whole frame). Objective checks, so the agent does not rely on its eye alone.
 */
export async function textReadability(doc: EditDocument, overlay: EditOverlay, vertical: boolean): Promise<string[]> {
  const [W, H] = vertical ? [540, 960] : [960, 540];
  const t = overlay.start + Math.min(0.6, overlay.duration / 2);
  const clip = doc.clips
    .filter((c) => (c.track ?? 0) === 0 && c.start <= t && t < c.start + c.duration)
    .map((c) => ({ c, a: doc.assets.find((a) => a.id === c.assetId) }))
    .find(({ a }) => a && (a.kind === "video" || a.kind === "image"));
  if (!clip?.a) return [];
  const input = ["-ss", String(Math.max(0, clip.a.kind === "image" ? 0 : clip.c.in + (t - clip.c.start) * (clip.c.speed ?? 1))), "-i", resolveInStorage(clip.a.path)];
  const fit = clip.c.fit === "contain"
    ? `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black`
    : `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}`;
  const b = textBox(overlay, vertical);
  const box = {
    x: Math.max(0, Math.round((b.x / 100) * W)), y: Math.max(0, Math.round((b.y / 100) * H)),
    w: Math.max(8, Math.round((Math.min(b.w, 100 - b.x) / 100) * W)), h: Math.max(8, Math.round((Math.min(b.h, 100 - b.y) / 100) * H)),
  };
  const crop = `crop=${box.w}:${box.h}:${box.x}:${box.y}`;
  const edges = "edgedetect=low=0.08:high=0.2";
  const [under, edgesUnder, edgesFrame] = await Promise.all([
    frameMean(input, `${fit},${crop}`),
    frameMean(input, `${fit},${edges},${crop}`),
    frameMean(input, `${fit},${edges}`),
  ]);
  const warnings: string[] = [];
  const boxed = overlay.background !== "transparent";
  if (under !== null && !boxed) {
    const light = luma(overlay.color) > 160;
    if (light && under > 150) warnings.push(translate("clear text on clear background (brightness {0} / 255 under text): put dark box or move it to a darker area", Math.round(under)));
    if (!light && under < 100) warnings.push(translate("dark text on dark background (brightness {0} / 255 under text): put clear box or change color", Math.round(under)));
  }
  if (edgesUnder !== null && edgesFrame !== null) {
    const ratio = edgesUnder / Math.max(edgesFrame, 0.5);
    if (ratio > 1.8 && edgesUnder > 6) warnings.push(translate("is on the area with more detail of the plane ({0} times the average detail); look at the image: if there is the subject (face, person, product), move it to a smoother area; if it is background (branches, leaves, texture) {1}", ratio.toFixed(1), boxed ? translate(" And the text already has a box, leave it") : ", ponle caja"));
    else if (!boxed && ratio > 1.3 && edgesUnder > 4) warnings.push(translate("the background under the text has a lot of detail and will cost to read it: put box or move it to a smooth area"));
  }
  return warnings;
}

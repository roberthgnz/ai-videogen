import { t as translate, localizedLabels, getLocale } from "@/lib/i18n";
import fs from "node:fs/promises";
import path from "node:path";
import { FORMAT_SIZE } from "@/lib/domain";
import { probeMedia } from "@/lib/media/ffprobe";
import { runFfmpeg } from "@/lib/media/ffmpeg";
import { escapeHtml } from "@/lib/pipeline/composition/html";
import { getRenderer } from "@/lib/pipeline/render";
import { getProject } from "@/lib/projects";
import { ensureDir, resolveInStorage, storagePaths, toStorageRelative } from "@/lib/storage";
import { appResource } from "../runtime";
import { clipSpeed, editDuration, type EditAsset, type EditClip, type EditDocument } from "./schema";

/**
 * Pictures the agent draws instead of looking for them: it writes the markup, the style sheet and the
 * animation of a full-frame graphic (an infographic, a map, a calendar, a paper collage in the style of the
 * user's reference) and HyperFrames renders it frame by frame into a video file of the project. From there it
 * is a clip like any other: it plays in the editor, shows in the filmstrips and is exported with the rest.
 */

/** Ids of the files made here: tells them apart from the user's footage and from stock. */
export const GRAPHIC_PREFIX = "graphic-";
export const isGraphic = (asset: Pick<EditAsset, "id">) => asset.id.startsWith(GRAPHIC_PREFIX) || asset.id.startsWith("grafico-");

/** What a graphic is made of, kept next to its video so it can be corrected or its style reused. */
export interface GraphicSource {
  name: string;
  description: string;
  html: string;
  css: string;
  animation: string;
  duration: number;
  background: string;
  width: number;
  height: number;
  /** Project images drawn inside it (written `asset:<id>` in the markup and style sheet) and the file each one is in the build. */
  images: { assetId: string; src: string }[];
}

const FPS = 30;
const round = (n: number) => Math.round(n * 1000) / 1000;
const EPS = 0.001;
/** The schema's shortest clip. */
const MIN_CLIP = 0.04;

/** What would make a render differ from the next one, or reach outside the project. */
const SCRIPT_RULES: [RegExp, string][] = localizedLabels((translate) => ([
  [/\bDate\.now\b|\bnew\s+Date\b|performance\.now/, translate("the real time (Date, performance.now): everything must depend on the time of tl")],
  [/Math\.random/, translate("Math.random: uses rnd (), which always gives the same sequence")],
  [/\bset(?:Timeout|Interval)\b|requestAnimationFrame/, "temporizadores: anima con tl (tl.to, tl.fromTo, tl.set, tl.call)"],
  [/\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|\bimport\s*\(|importScripts/, translate("code network or load")],
  [/repeat\s*:\s*-1/, translate("repeat: -1: repeat a finite number of times")],
  [/<\/script/i, "la etiqueta </script>"],
  [/__timelines/, translate("window. _ _ timelines: the time line tl already exists and the study records it")],
]));
const STYLE_RULES: [RegExp, string][] = [
  [/@keyframes|(?:^|[;{\s])animation(?:-name)?\s*:/i, "animaciones CSS (@keyframes, animation): anima con tl en `animation`"],
  [/(?:^|[;{\s])transition(?:-[a-z]+)?\s*:/i, "transition: el render salta de fotograma en fotograma, anima con tl"],
  [/@import/i, "@import"],
  [/<\/style/i, "la etiqueta </style>"],
];
const MARKUP_RULES: [RegExp, string][] = [
  [/<script/i, "<script>: el JavaScript va en `animation`"],
  [/<(?:iframe|object|embed|link|meta|base)\b/i, "iframe, object, embed, link, meta o base"],
  [/\son[a-z]+\s*=/i, "atributos de evento (onclick, onload…)"],
];
/** Any address that is not the SVG and XLink namespaces. */
const EXTERNAL = /https?:\/\/(?!www\.w3\.org\/)/i;
/** A project image inside a graphic: `src="asset:<id>"` or `url(asset:<id>)`, swapped for the copied file at render. */
const IMAGE_TOKEN = /(["'(])asset:([a-zA-Z0-9_-]{1,80})(?=["')])/g;

/** Ids of the project images a graphic draws. */
export function graphicImageIds(source: Pick<GraphicSource, "html" | "css">): string[] {
  return [...new Set([...`${source.html}\n${source.css}`.matchAll(IMAGE_TOKEN)].map((m) => m[2]))];
}

/** Why a graphic cannot be rendered as written, in words the agent can act on. Empty when it can. */
export function graphicIssues(source: Pick<GraphicSource, "html" | "css" | "animation">): string[] {
  const issues: string[] = [];
  const check = (text: string, rules: [RegExp, string][], where: string) => {
    for (const [pattern, why] of rules) if (pattern.test(text)) issues.push(`${where}: no uses ${why}.`);
  };
  check(source.html, MARKUP_RULES, "html");
  check(source.css, STYLE_RULES, "css");
  check(source.animation, SCRIPT_RULES, "animation");
  if (/<style/i.test(source.html)) check(source.html, STYLE_RULES, "html");
  if ([source.html, source.css, source.animation].some((text) => EXTERNAL.test(text))) {
    issues.push(translate("No external addresses (images, sources or Internet scripts) are allowed: draw with HTML, CSS and SVG, use the sources included and the project images with `images`."));
  }
  return issues;
}

/**
 * The page HyperFrames renders: one root composition whose timeline is `tl`. The agent's code runs with
 * `tl`, `gsap`, `stage`, `W`, `H`, `D`, a seeded `rnd()` and `drawPath()` (a stroke that draws itself, in real
 * path lengths, because a dash offset between 0 and 1 is rounded and the line pops in whole, and starting a
 * stroke's width before the path, so a round cap leaves no dot while it waits); the skeleton around it is always the same, so
 * the render contract (root, duration, one registered timeline) never depends on what the agent wrote. An
 * error in its code is drawn on the frame instead of leaving a silent, static video.
 */
export function composeGraphicHtml(source: GraphicSource): string {
  const { width: W, height: H, duration: D, background } = source;
  // One frame more than asked: however the renderer rounds, the file is never shorter than the clip it fills.
  const total = (Math.ceil(D * FPS - 1e-6) + 1) / FPS;
  const files = new Map(source.images.map((i) => [i.assetId, i.src]));
  const withImages = (text: string) => text.replace(IMAGE_TOKEN, (whole, open: string, id: string) => files.has(id) ? `${open}${files.get(id)}` : whole);
  return `<!doctype html><html lang="${getLocale()}"><head><meta charset="utf-8"><title>${escapeHtml(source.name)}</title><script src="assets/gsap.min.js"></script><style>*{box-sizing:border-box}html,body{margin:0;width:${W}px;height:${H}px;overflow:hidden;background:${background}}#root{position:relative;width:${W}px;height:${H}px;overflow:hidden}#stage{position:absolute;inset:0;overflow:hidden;background:${background};color:#111111;font-family:Inter,sans-serif}#stage-error{position:absolute;left:0;top:0;width:100%;padding:40px;background:#c40000;color:#ffffff;font:700 34px/1.3 Inter,sans-serif;z-index:99999;white-space:pre-wrap}
${withImages(source.css)}
</style></head><body><div id="root" data-composition-id="main" data-start="0" data-duration="${total}" data-width="${W}" data-height="${H}" data-fps="${FPS}"><div id="stage" data-layout-ignore>
${withImages(source.html)}
</div></div><script>window.__timelines=window.__timelines||{};(function(){var W=${W},H=${H},D=${D};var stage=document.getElementById("stage");var seed=20240519;function rnd(){seed|=0;seed=seed+0x6D2B79F5|0;var t=Math.imul(seed^seed>>>15,1|seed);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}var tl=gsap.timeline({paused:true});function drawPath(target,vars,position){gsap.utils.toArray(target).forEach(function(el){var pad=(parseFloat(getComputedStyle(el).strokeWidth)||0)+2,dash=el.getTotalLength()+2*pad;gsap.set(el,{strokeDasharray:dash});tl.fromTo(el,{strokeDashoffset:dash+pad},Object.assign({strokeDashoffset:2*pad,duration:.5,ease:"none"},vars||{}),position);});}try{(function(){
${source.animation}
})();}catch(error){var box=document.createElement("div");box.id="stage-error";box.textContent="ANIMATION ERROR: "+(error&&error.message?error.message:error);stage.appendChild(box);}tl.set({},{},${total});window.__timelines["main"]=tl;})();</script></body></html>`;
}

const sourceFile = (projectId: string, assetId: string) => path.join(storagePaths.project(projectId), "media", assetId, "source.json");

/** What a graphic of this project was made of, or null if it is not one (or its source is gone). */
export async function readGraphicSource(projectId: string, assetId: string): Promise<GraphicSource | null> {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(assetId) || !isGraphic({ id: assetId })) return null;
  try {
    const saved = JSON.parse(await fs.readFile(sourceFile(projectId, assetId), "utf8")) as Partial<GraphicSource>;
    if (typeof saved.html !== "string" || typeof saved.css !== "string" || typeof saved.animation !== "string") return null;
    return { name: saved.name ?? "", description: saved.description ?? "", html: saved.html, css: saved.css, animation: saved.animation,
      duration: Number(saved.duration) || 0, background: saved.background ?? "#101018", width: Number(saved.width) || 0, height: Number(saved.height) || 0, images: saved.images ?? [] };
  } catch {
    return null;
  }
}

// One render at a time: each one starts its own headless browsers. Shared with whole compositions (compositions.ts).
const globalForGraphics = globalThis as unknown as { __videogenGraphics?: Promise<unknown> };
export function inTurn<T>(task: () => Promise<T>): Promise<T> {
  const run = (globalForGraphics.__videogenGraphics ?? Promise.resolve()).then(task, task);
  globalForGraphics.__videogenGraphics = run.catch(() => undefined);
  return run;
}

export interface GraphicInput {
  name: string;
  description: string;
  html: string;
  css: string;
  animation: string;
  /** Seconds the graphic is meant to be on screen (`D` in its animation). */
  duration: number;
  background?: string;
}

/**
 * Renders a graphic into `media/<id>/media.mp4` of the project (silent, at the project's format) and keeps
 * its source next to it. Returns the file as a library entry; adding it to the montage is the caller's.
 */
export async function renderGraphic(projectId: string, input: GraphicInput, signal?: AbortSignal): Promise<{ asset: EditAsset; source: GraphicSource }> {
  const p = getProject(projectId);
  if (!p) throw new Error(translate("The project no longer exists."));
  const { width, height } = FORMAT_SIZE[p.format];
  const used = graphicImageIds(input).map((assetId) => {
    const asset = p.edit.assets.find((a) => a.id === assetId);
    if (!asset || asset.kind !== "image") throw new Error(translate("\"asset: {0}\" is not a project image: only image files can be drawn, by their id.", assetId));
    return { asset, src: `assets/${asset.id}${path.extname(asset.path) || ".png"}` };
  });
  const source: GraphicSource = { name: input.name.trim(), description: input.description.trim(), html: input.html, css: input.css, animation: input.animation, duration: round(input.duration),
    background: input.background ?? p.edit.background, width, height, images: used.map((u) => ({ assetId: u.asset.id, src: u.src })) };
  const issues = graphicIssues(source);
  if (issues.length) throw new Error(translate("Could not render the graphic:\n- {0}", issues.join("\n- ")));

  const id = `${GRAPHIC_PREFIX}${crypto.randomUUID()}`;
  const dir = ensureDir(path.join(storagePaths.project(projectId), "media", id));
  const build = path.join(storagePaths.project(projectId), "graphics", id);
  const rendered = path.join(dir, "render.mp4");
  const file = path.join(dir, "media.mp4");
  try {
    await fs.mkdir(path.join(build, "assets"), { recursive: true });
    await fs.copyFile(appResource("node_modules", "gsap", "dist", "gsap.min.js"), path.join(build, "assets", "gsap.min.js"));
    for (const image of used) await fs.copyFile(resolveInStorage(image.asset.path), path.join(build, ...image.src.split("/")));
    await fs.writeFile(path.join(build, "index.html"), composeGraphicHtml(source));
    await inTurn(() => getRenderer().render({ projectDir: build, outFile: rendered, quality: "looks", signal }));
    // No sound track: a graphic must never count as a file with a voice to transcribe.
    await runFfmpeg(["-v", "error", "-y", "-i", rendered, "-map", "0:v:0", "-an", "-c:v", "copy", "-movflags", "+faststart", file], signal);
    await fs.rm(rendered, { force: true });
    const info = await probeMedia(file);
    const stream = info.streams.find((s) => s.type === "video");
    if (!stream || info.durationSec <= 0) throw new Error(translate("The graph's render does not contain video."));
    await fs.writeFile(sourceFile(projectId, id), JSON.stringify(source, null, 2));
    const asset: EditAsset = { id, name: translate("Figure · {0}", source.name).slice(0, 240), kind: "video", path: toStorageRelative(file), duration: info.durationSec,
      width: stream.width ?? width, height: stream.height ?? height, hasAudio: false, context: translate("Own graph made by the assistant: {0}", source.description || source.name).slice(0, 16000) };
    return { asset, source };
  } catch (error) {
    // Only the folder created above for this graphic, inside this project's media.
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    throw error;
  } finally {
    await fs.rm(build, { recursive: true, force: true }).catch(() => {});
  }
}

/** Removes the files of a graphic that a newer version replaced. Never anything outside the project's media. */
export async function discardGraphicFiles(projectId: string, assetId: string): Promise<void> {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(assetId) || !isGraphic({ id: assetId })) return;
  const root = storagePaths.project(projectId);
  const dir = path.join(root, "media", assetId);
  if (path.relative(root, dir).startsWith("media")) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}

export interface GraphicPlacement {
  /** Swap the picture of this clip for the graphic; the clip keeps its place and length. */
  replaceClipId?: string;
  /** Put the graphic at this second, cutting away what it covers on its track. */
  start?: number;
  /** How long it stays there; the file may be a frame longer. */
  duration?: number;
  track?: number;
  /** An earlier version of this graphic: its clips show the new one and the old file leaves the library. */
  replaces?: string;
}

/** The moments worth looking at in a graphic: spread over its length, the last one on its final state. */
export function graphicFrameTimes(duration: number, count = 6): number[] {
  const last = Math.max(0, duration - 0.08);
  return Array.from({ length: count }, (_, i) => Math.round(Math.min(last, i === count - 1 ? last : ((i + 0.5) * duration) / count) * 100) / 100);
}

/**
 * An overwrite edit: `clip` takes its stretch of its video track, and what was under it there is cut away
 * (removed, trimmed, or split in two around it). Other tracks, sound and texts are untouched.
 */
export function overwritePicture(doc: EditDocument, clip: EditClip): EditDocument {
  const kinds = new Map(doc.assets.map((a) => [a.id, a.kind]));
  const from = clip.start, to = clip.start + clip.duration, track = clip.track ?? 0;
  const clips = doc.clips.flatMap((c): EditClip[] => {
    const kind = kinds.get(c.assetId);
    if ((kind !== "video" && kind !== "image") || (c.track ?? 0) !== track) return [c];
    const a = c.start, b = c.start + c.duration;
    if (b <= from + EPS || a >= to - EPS) return [c];
    const pieces: EditClip[] = [];
    if (from - a >= MIN_CLIP) pieces.push({ ...c, duration: round(from - a) });
    // What is left after the graphic continues the same shot from where the graphic ends.
    if (b - to >= MIN_CLIP) pieces.push({ ...c, id: pieces.length ? crypto.randomUUID() : c.id, start: round(to), duration: round(b - to), in: kind === "image" ? c.in : round(c.in + (to - a) * clipSpeed(c)), transition: "cut" });
    return pieces;
  });
  const next = { ...doc, enabled: true, clips: [...clips, clip] };
  const content = editDuration({ ...next, duration: 0.1 });
  // An empty montage is as long as what is put on it, not the 15 s placeholder.
  return { ...next, duration: doc.clips.length || doc.overlays.length ? Math.max(doc.duration, round(content)) : round(content) };
}

/**
 * Adds a rendered graphic to the montage's files and, if asked, to its clips. Pure. Throws when the clip
 * or the earlier version it was meant for is no longer there (the montage changed while it rendered).
 */
export function placeGraphic(doc: EditDocument, asset: EditAsset, where: GraphicPlacement): { doc: EditDocument; placed: string[] } {
  const placed: string[] = [];
  let next: EditDocument = { ...doc, enabled: true, assets: [...doc.assets.filter((a) => a.id !== where.replaces), asset] };
  if (where.replaces) {
    if (!doc.assets.some((a) => a.id === where.replaces)) throw new Error(translate("The previous version of the graph is no longer in the project."));
    let swapped = 0;
    next = { ...next, clips: next.clips.map((c) => {
      if (c.assetId !== where.replaces) return c;
      swapped++;
      const speed = clipSpeed(c);
      // The new version may be shorter: the clip keeps its place and shows what there is.
      const fits = c.in + c.duration * speed <= asset.duration + 0.05;
      return fits ? { ...c, assetId: asset.id } : { ...c, assetId: asset.id, in: 0, duration: round(Math.max(MIN_CLIP, Math.min(c.duration, asset.duration / speed))) };
    }) };
    placed.push(swapped ? translate("replace the previous version in {0}", swapped === 1 ? "su clip" : `sus ${swapped} clips`) : translate("replace the previous version, which was not in the timeline"));
  }
  if (where.replaceClipId) {
    const target = next.clips.find((c) => c.id === where.replaceClipId);
    if (!target) throw new Error(translate("The clip I was going to replace is no longer in the assembly."));
    const swapped: EditClip = { ...target, assetId: asset.id, in: 0, volume: 0, fit: "cover", duration: round(Math.min(target.duration, asset.duration)) };
    delete swapped.speed;
    next = { ...next, clips: next.clips.map((c) => c.id === target.id ? swapped : c) };
    placed.push(`ocupa el clip ${target.id} (${target.start.toFixed(2)}–${(target.start + swapped.duration).toFixed(2)} s)`);
  }
  if (where.start !== undefined) {
    const clip: EditClip = { id: crypto.randomUUID(), assetId: asset.id, start: round(where.start), in: 0, duration: round(Math.min(asset.duration, where.duration ?? asset.duration)), volume: 0, fit: "cover", transition: "cut", motion: "none", track: where.track ?? 0 };
    next = overwritePicture(next, clip);
    placed.push(translate("placed as clip {0} in {1} - {2} s, track {3}, cutting what it covered on that track", clip.id, clip.start.toFixed(2), (clip.start + clip.duration).toFixed(2), clip.track));
  }
  return { doc: next, placed };
}

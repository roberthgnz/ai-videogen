import { getLocale } from "@/lib/i18n";
import path from "node:path";
import type { CSSProperties } from "react";
import { FORMAT_SIZE, type VideoFormat } from "@/lib/domain";
import { resolveInStorage } from "@/lib/storage";
import type { CompositionPlan } from "@/lib/pipeline/composition";
import { escapeHtml } from "@/lib/pipeline/composition/html";
import { editDuration, type EditDocument } from "./schema";
import { clipKeyframes } from "./motion";
import { overlayStyle } from "./style";
import { emphasisHtml } from "./emphasis";
import { layeredClips } from "./timeline";
import { appResource } from "../runtime";

function css(style: CSSProperties) {
  return Object.entries(style).map(([key, value]) => `${key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}:${value}`).join(";");
}

/**
 * GSAP calls for the transition and slow move of every picture clip (see motion.ts). The transition is
 * sampled once per frame and the move is a single linear tween after it, so the two never fight over the
 * same property and any seek lands on exactly what the editor shows.
 */
export function clipEffectsScript(doc: EditDocument): string {
  const lines: string[] = [];
  for (const clip of doc.clips) {
    const asset = doc.assets.find((a) => a.id === clip.assetId);
    if (!asset || asset.kind === "audio" || asset.kind === "document") continue;
    if (clip.transition === "cut" && clip.motion === "none") continue;
    const target = JSON.stringify(`#clip-${clip.id}`);
    const { steps, tail } = clipKeyframes(clip);
    for (const { at, frame } of steps) lines.push(`tl.set(${target},{opacity:${round(frame.opacity)},xPercent:${round(frame.x)},scale:${round(frame.scale)}},${at});`);
    if (tail) lines.push(`tl.fromTo(${target},{scale:${round(tail.from)}},{scale:${round(tail.to)},duration:${tail.duration},ease:"none",immediateRender:false},${tail.at});`);
  }
  return lines.join("");
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/** Same timing, positions and source trims as the live editor. No TTS or stock lookup. */
export function planEditComposition(doc: EditDocument, format: VideoFormat, title: string): CompositionPlan {
  const { width, height } = FORMAT_SIZE[format];
  const durationSec = editDuration(doc);
  const files: CompositionPlan["files"] = new Map();
  files.set("assets/fonts/editor-inter-700.woff2", { copyFrom: appResource("public", "fonts", "editor-inter-700.woff2") });
  files.set("assets/gsap.min.js", { copyFrom: appResource("node_modules", "gsap", "dist", "gsap.min.js") });
  // A clip on a higher video track covers the ones below, as on the timeline.
  const media = layeredClips(doc).map((clip, index) => {
    const asset = doc.assets.find((a) => a.id === clip.assetId)!;
    const src = `assets/${asset.id}${path.extname(asset.path)}`;
    files.set(src, { copyFrom: resolveInStorage(asset.path) });
    const tag = asset.kind === "image" ? "img" : asset.kind;
    const audio = asset.kind === "video" ? (asset.hasAudio && clip.volume > 0 ? 'data-has-audio="true" playsinline' : "muted playsinline") : "";
    // Music (audio-only clips) fades in and out so it never starts or ends on a hard edge.
    const fades = asset.kind === "audio" ? `data-fade-in="${Math.min(0.3, clip.duration / 4)}" data-fade-out="${Math.min(1.5, clip.duration / 3)}"` : "";
    const style = asset.kind !== "audio" ? `position:absolute;inset:0;width:${width}px;height:${height}px;object-fit:${clip.fit};z-index:${index + 1}` : "";
    return `<${tag} id="clip-${clip.id}" class="clip" src="${src}" data-start="${clip.start}" data-duration="${clip.duration}" data-media-start="${clip.in}"${clip.speed && clip.speed !== 1 ? ` data-playback-rate="${clip.speed}"` : ""} data-track-index="${index + 1}" data-volume="${clip.volume}" ${fades} ${audio} style="${style}">${tag === "img" ? "" : `</${tag}>`}`;
  });
  // Distinct hosts keep captions editable as one lane in the HyperFrames desktop app.
  const hosts = (["text", "caption"] as const).map((kind, index) => {
    const id = kind === "text" ? "overlays" : "captions";
    const items = doc.overlays.filter((o) => o.kind === kind);
    if (!items.length) return "";
    const graphics = items.map((o) => `<div id="overlay-${o.id}" class="clip" data-start="${o.start}" data-duration="${o.duration}" style="${escapeHtml(css(overlayStyle(o)))};opacity:${o.start === 0 ? 1 : 0};z-index:1000" data-layout-allow-overlap>${emphasisHtml(o, escapeHtml)}</div>`).join("\n");
    const tweens = items.map((o) => `tl.set("#overlay-${o.id}",{opacity:1},${o.start});tl.set("#overlay-${o.id}",{opacity:0},${o.start + o.duration});`).join("\n");
    files.set(`compositions/${id}.html`, `<template><style>@font-face{font-family:VideoGenCanvas;src:url('assets/fonts/editor-inter-700.woff2') format('woff2');font-weight:700}#root{position:absolute;inset:0}</style><div id="root" data-composition-id="${id}" data-width="${width}" data-height="${height}">${graphics}</div><script>var tl=gsap.timeline({paused:true});${tweens}tl.set({},{},${durationSec});window.__timelines["${id}"]=tl;</script></template>`);
    return `<div id="${id}" class="clip" data-composition-id="${id}" data-composition-src="compositions/${id}.html" data-start="0" data-duration="${durationSec}" data-width="${width}" data-height="${height}" data-track-index="${doc.clips.length + 1 + index}" data-track-kind="${kind === "caption" ? "captions" : "graphics"}" style="z-index:${1000 + index}"></div>`;
  }).join("\n");
  files.set("index.html", `<!doctype html><html lang="${getLocale()}"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><script src="assets/gsap.min.js"></script><style>*{box-sizing:border-box}html,body{margin:0;width:${width}px;height:${height}px;overflow:hidden;background:${doc.background}}#root{position:relative;width:100%;height:100%}</style></head><body><div id="root" data-composition-id="main" data-start="0" data-duration="${durationSec}" data-width="${width}" data-height="${height}" data-fps="30"><div style="position:absolute;inset:0;background:${doc.background}" data-layout-ignore></div>${media.join("\n")}${hosts}</div><script>window.__timelines=window.__timelines||{};var tl=gsap.timeline({paused:true});tl.set({},{},${durationSec});${clipEffectsScript(doc)}window.__timelines["main"]=tl;</script></body></html>`);
  return { width, height, durationSec, scenes: [], transitions: [], files };
}

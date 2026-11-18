import { t as translate, getLocale } from "@/lib/i18n";
import fs from "node:fs";
import path from "node:path";
import { appResource } from "../../runtime";
import type {
  CaptionStyleId,
  SceneContent,
  TemplateId,
  TransitionId,
  VideoFormat,
  VisualKind,
  WordTiming,
} from "@/lib/domain";
import { SCENE_COMPOSERS, sceneHtmlSource } from "@/templates/compose-registry";
import { getTemplate } from "@/templates/registry";
import { theme as defaultTheme, type Theme } from "@/theme";
import { PipelineError } from "../errors";
import { captionGroupsForScenes, captionLimits, captionsHtml } from "./captions";
import { escapeHtml, fillTemplate, sec } from "./html";
import { layoutFor, themeCss, type Layout } from "./layout";
import { duckingPoints, speechSpans } from "../audio/ducking";
import { planShots, sceneWordStarts } from "../visuals/shots";
import {
  SCENE_BASE_CSS,
  TRANSITION_SEC,
  backgroundHtml,
  backgroundParts,
  brollParts,
  exitTween,
  transitionTweens,
  type BrollShot,
  type SceneTransition,
} from "./shared";

export interface ComposeSceneInput {
  template: TemplateId;
  content: SceneContent;
  words: WordTiming[];
  /** Absolute path to the narration audio. */
  audioFile: string;
  /** Real audio duration (ffprobe). Drives the scene's length. */
  audioDurationSec: number;
  /**
   * B-roll assets in shot order, already cropped to the frame (absolute paths).
   * None: the scene uses the animated gradient background.
   */
  shots?: { file: string; kind: VisualKind }[];
}

export interface CompositionInput {
  title: string;
  format: VideoFormat;
  fps?: number;
  scenes: ComposeSceneInput[];
  /** Caption look (default "pop"). */
  captionStyle?: CaptionStyleId;
  /** Transition between scenes (default "auto"). */
  transition?: TransitionId;
  /** Background music, already cut to the video's length (absolute path). Ducked under the voice. */
  music?: string;
  /** Transition effects (absolute paths), used in rotation on every animated scene change. */
  sfx?: string[];
  theme?: Theme;
}

export interface SceneSlot {
  id: string;
  start: number;
  duration: number;
  narrationStart: number;
}

export interface CompositionPlan {
  width: number;
  height: number;
  durationSec: number;
  scenes: SceneSlot[];
  /** Where each scene change happens (absolute seconds) and how; hard cuts included. */
  transitions: { at: number; kind: SceneTransition | "cut" }[];
  /** Project-relative path -> file content, or a file to copy. */
  files: Map<string, string | { copyFrom: string }>;
}

/** Scene slots from the real audio: lead + audio + tail, back to back. */
export function sceneSlots(durations: number[], theme: Theme): SceneSlot[] {
  let t = 0;
  return durations.map((audio, i) => {
    const duration = sec(theme.timing.sceneLead + audio + theme.timing.sceneTail);
    const slot = { id: `scene-${i}`, start: sec(t), duration, narrationStart: theme.timing.sceneLead };
    t = sec(t + duration);
    return slot;
  });
}

const AUTO_TRANSITIONS: SceneTransition[] = ["zoom", "slide", "fade"];

/**
 * The transition after each scene (null after the last one and for hard
 * cuts). "auto" rotates through the animated ones so no two changes in a row
 * look the same.
 */
export function sceneTransitions(count: number, setting: TransitionId): (SceneTransition | null)[] {
  return Array.from({ length: count }, (_, i) => {
    if (i === count - 1 || setting === "cut") return null;
    return setting === "auto" ? AUTO_TRANSITIONS[i % AUTO_TRANSITIONS.length] : setting;
  });
}

/**
 * GSAP shipped with the build. Resolved on disk (not via require.resolve,
 * which the Next.js bundler rewrites to a virtual module id).
 */
function gsapFile(): string {
  const file = appResource("node_modules", "gsap", "dist", "gsap.min.js");
  if (!fs.existsSync(file)) throw new PipelineError("composition", translate("GSAP is not found in {0} (npm install?).", file));
  return file;
}

/**
 * Composition step: project data -> a HyperFrames project (index.html,
 * one sub-composition per scene, one captions layer, audio and GSAP in assets).
 * Pure: returns the files; `writeComposition` puts them on disk.
 */
export function planComposition(input: CompositionInput): CompositionPlan {
  const theme = input.theme ?? defaultTheme;
  const layout = layoutFor(input.format);
  if (input.scenes.length === 0) throw new PipelineError("composition", translate("There are no scenes to compose."));

  input.scenes.forEach((scene, i) => {
    if (!(scene.audioDurationSec > 0)) {
      throw new PipelineError("composition", translate("The {0} scene does not have a valid audio duration.", i + 1));
    }
    const issues = getTemplate(scene.template).schema.safeParse(scene.content);
    if (!issues.success) {
      throw new PipelineError("composition", translate("The {0} scene has invalid content for \"{1}.\"", i + 1, scene.template));
    }
  });

  const slots = sceneSlots(
    input.scenes.map((s) => s.audioDurationSec),
    theme,
  );
  const total = sec(slots.at(-1)!.start + slots.at(-1)!.duration);
  const files: CompositionPlan["files"] = new Map();

  const transitions = sceneTransitions(input.scenes.length, input.transition ?? "auto");
  input.scenes.forEach((scene, i) => {
    // During a transition the scene stays on screen over the start of the next one.
    const broll = brollShots(scene, slots[i], transitions[i] ? TRANSITION_SEC : 0);
    broll.forEach((shot, k) => files.set(shot.src, { copyFrom: scene.shots![k].file }));
    const kinds = { in: i > 0 ? transitions[i - 1] : null, out: transitions[i] };
    files.set(`compositions/${slots[i].id}.html`, sceneHtml(scene, slots[i], i, input.scenes.length, layout, theme, broll, kinds));
    files.set(`assets/audio/${slots[i].id}${path.extname(scene.audioFile) || ".mp3"}`, { copyFrom: scene.audioFile });
  });

  const captionStyle = input.captionStyle ?? "pop";
  const limits = captionLimits(theme, captionStyle, input.format);
  const groups = captionGroupsForScenes(
    input.scenes.map((s, i) => ({
      start: slots[i].start,
      narrationStart: slots[i].start + slots[i].narrationStart,
      end: slots[i].start + slots[i].duration,
      words: s.words,
    })),
    limits.maxWords,
    limits.maxChars,
  );
  files.set("compositions/captions.html", captionsHtml(groups, theme, layout, total, captionStyle));
  files.set("assets/vendor/gsap.min.js", { copyFrom: gsapFile() });
  const extraAudio = soundtrack(input, slots, total, transitions, theme, files);
  files.set("index.html", indexHtml(input, slots, total, layout, theme, transitions, extraAudio));
  files.set("meta.json", JSON.stringify({ id: "videogen", name: input.title || "VideoGen" }, null, 2));

  return {
    width: layout.width,
    height: layout.height,
    durationSec: total,
    scenes: slots,
    transitions: slots.slice(0, -1).map((slot, i) => ({ at: sec(slot.start + slot.duration), kind: transitions[i] ?? "cut" })),
    files,
  };
}

/** Total length of a video whose scenes have these audio durations. */
export function compositionDuration(audioDurations: number[], theme: Theme = defaultTheme): number {
  const slots = sceneSlots(audioDurations, theme);
  const last = slots.at(-1);
  return last ? sec(last.start + last.duration) : 0;
}

/**
 * Music bed and transition effects as `<audio>` clips. The music carries a
 * volume envelope that ducks it under every phrase; effects start a moment
 * before each animated scene change, rotating through the available files.
 */
function soundtrack(
  input: CompositionInput,
  slots: SceneSlot[],
  total: number,
  transitions: (SceneTransition | null)[],
  theme: Theme,
  files: CompositionPlan["files"],
): string[] {
  const a = theme.audio;
  const clips: string[] = [];
  if (input.music) {
    const src = `assets/audio/music${path.extname(input.music) || ".mp3"}`;
    files.set(src, { copyFrom: input.music });
    const spans = speechSpans(
      input.scenes.map((s, i) => ({ narrationStart: slots[i].start + slots[i].narrationStart, words: s.words })),
      a.duckMinGap,
    );
    const lane = {
      version: 1,
      lanes: [
        {
          target: "volume",
          points: duckingPoints(spans, total, { full: a.musicFull, ducked: a.musicDucked, attack: a.duckAttack, release: a.duckRelease }),
        },
      ],
    };
    clips.push(
      `      <audio id="music" class="clip" src="${src}" data-start="0" data-duration="${total}" data-track-index="5" data-volume="1" data-fade-in="${a.musicFadeIn}" data-fade-out="${Math.min(a.musicFadeOut, total / 3)}" data-automation="${escapeHtml(JSON.stringify(lane))}"></audio>`,
    );
  }
  const sfx = input.sfx ?? [];
  if (sfx.length) {
    sfx.forEach((file, k) => files.set(`assets/audio/sfx-${k}${path.extname(file) || ".mp3"}`, { copyFrom: file }));
    let used = 0;
    transitions.forEach((kind, i) => {
      if (!kind) return;
      const k = used++ % sfx.length;
      const at = sec(Math.max(0, slots[i].start + slots[i].duration - a.sfxLead));
      clips.push(
        `      <audio id="sfx-${i}" class="clip" src="assets/audio/sfx-${k}${path.extname(sfx[k]) || ".mp3"}" data-start="${at}" data-track-index="${6 + (used % 2)}" data-volume="${a.sfxVolume}"></audio>`,
      );
    });
  }
  return clips;
}

/** The scene's assets laid over its duration as 2-4 s shots cut on word starts. */
function brollShots(scene: ComposeSceneInput, slot: SceneSlot, tail = 0): BrollShot[] {
  const assets = scene.shots ?? [];
  if (assets.length === 0) return [];
  const shots = planShots(slot.duration, sceneWordStarts(scene.words, slot.narrationStart), assets.length);
  return shots.map((shot, k) => ({
    src: `assets/media/${path.basename(assets[k].file)}`,
    kind: assets[k].kind,
    start: shot.start,
    // The last shot keeps playing through the transition into the next scene.
    duration: k === shots.length - 1 ? sec(shot.duration + tail) : shot.duration,
  }));
}

function sceneHtml(
  scene: ComposeSceneInput,
  slot: SceneSlot,
  index: number,
  count: number,
  layout: Layout,
  theme: Theme,
  broll: BrollShot[],
  transition: { in: SceneTransition | null; out: SceneTransition | null },
): string {
  const prefix = `s${index}`;
  const isLast = index === count - 1;
  const seed = 1000 + index * 7919;
  const bg = broll.length
    ? brollParts(prefix, seed, layout, broll)
    : { html: backgroundHtml(prefix), ...backgroundParts(prefix, seed, layout, slot.duration) };
  const specific = SCENE_COMPOSERS[scene.template]({
    id: slot.id,
    prefix,
    index,
    isLast,
    duration: slot.duration,
    narrationStart: slot.narrationStart,
    words: scene.words,
    content: scene.content,
    layout,
    theme,
  });
  return fillTemplate(sceneHtmlSource(scene.template), {
    id: slot.id,
    prefix,
    width: layout.width,
    height: layout.height,
    duration: slot.duration,
    baseCss: SCENE_BASE_CSS,
    background: bg.html,
    backgroundCss: bg.css,
    backgroundTweens: bg.tweens,
    exitTween: [exitTween(prefix, slot.duration, isLast), transitionTweens(prefix, slot.duration, transition)]
      .filter(Boolean)
      .join("\n      "),
    ...specific,
  });
}

function indexHtml(
  input: CompositionInput,
  slots: SceneSlot[],
  total: number,
  layout: Layout,
  theme: Theme,
  transitions: (SceneTransition | null)[],
  extraAudio: string[],
): string {
  const { width, height } = layout;
  const fps = input.fps ?? 30;
  const hosts = slots
    .map(
      // A scene with a transition outlasts its slot and sits above the next one, which
      // is revealed under it; overlapping scenes alternate between two tracks.
      (s, i) => `      <div
        id="${s.id}"
        data-composition-id="${s.id}"
        data-composition-src="compositions/${s.id}.html"
        data-start="${s.start}"
        data-duration="${sec(s.duration + (transitions[i] ? TRANSITION_SEC : 0))}"
        data-track-index="${i % 2 === 0 ? 1 : 4}"
        data-track-kind="graphics"
        data-width="${width}"
        data-height="${height}"
        style="z-index: ${100 - i}"
      ></div>`,
    )
    .join("\n");
  const audio = slots
    .map(
      (s, i) =>
        `      <audio id="vo-${i}" class="clip" src="assets/audio/${s.id}${path.extname(input.scenes[i].audioFile) || ".mp3"}" data-start="${sec(s.start + s.narrationStart)}" data-duration="${sec(input.scenes[i].audioDurationSec)}" data-track-index="3" data-volume="1"></audio>`,
    )
    .concat(extraAudio)
    .join("\n");

  return `<!doctype html>
<html lang="${getLocale()}">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${width}, height=${height}" />
    <title>${input.title.replace(/</g, "&lt;")}</title>
    <script src="assets/vendor/gsap.min.js"></script>
    <style>
${themeCss(theme, layout)}
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { width: ${width}px; height: ${height}px; overflow: hidden; background: var(--bg-bottom); }
      #root { position: relative; width: 100%; height: 100%; }
    </style>
  </head>
  <body>
    <div
      id="root"
      data-composition-id="main"
      data-start="0"
      data-duration="${total}"
      data-width="${width}"
      data-height="${height}"
      data-fps="${fps}"
    >
${hosts}
      <div
        id="captions"
        data-composition-id="captions"
        data-composition-src="compositions/captions.html"
        data-start="0"
        data-duration="${total}"
        data-track-index="2"
        data-track-kind="captions"
        data-width="${width}"
        data-height="${height}"
        style="z-index: 200"
      ></div>
${audio}
    </div>
    <script>
      window.__timelines = window.__timelines || {};
      window.__timelines["main"] = gsap.timeline({ paused: true });
    </script>
  </body>
</html>
`;
}

/** Writes a plan to `dir`, replacing any previous build there. */
export function writeComposition(plan: CompositionPlan, dir: string): void {
  // Empty the folder instead of removing it: on Windows the folder itself
  // cannot be deleted while a terminal or a preview has it open.
  fs.mkdirSync(dir, { recursive: true });
  for (const entry of fs.readdirSync(dir)) fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
  for (const [rel, content] of plan.files) {
    const target = path.join(dir, ...rel.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (typeof content === "string") fs.writeFileSync(target, content);
    else fs.copyFileSync(content.copyFrom, target);
  }
}

export { layoutFor } from "./layout";

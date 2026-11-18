import { localizedLabels, t as translate } from "@/lib/i18n";
import type { EditClip } from "./schema";

/** How a clip arrives. The effect plays inside the clip's own first moments, so the timing of the montage never changes. */
export const CLIP_TRANSITIONS = ["cut", "fade", "slide", "zoom"] as const;
export type ClipTransition = (typeof CLIP_TRANSITIONS)[number];

/** Slow camera move over the whole clip: push in, or pull back. */
export const CLIP_MOTIONS = ["none", "push", "pull"] as const;
export type ClipMotion = (typeof CLIP_MOTIONS)[number];

/** Speeds offered in the editor (the model may use anything from 0.25 to 4). */
export const SPEED_CHOICES = [0.5, 0.75, 1, 1.5, 2, 3] as const;
export const speedLabel = (speed: number) => `${String(speed).replace(".", ",")}×`;

export const TRANSITION_LABELS: Record<ClipTransition, string> = localizedLabels((translate) => ({ cut: translate("Court"), fade: translate("Fade"), slide: "Deslizar", zoom: "Zoom" }));
export const MOTION_LABELS: Record<ClipMotion, string> = localizedLabels((translate) => ({ none: translate("None"), push: translate("Zoom in"), pull: translate("Zoom out") }));

/** Length of a transition (s); a shorter clip uses at most half of itself. */
export const TRANSITION_SECONDS = 0.3;
/** Scale reached by the slow move (1 = the frame as it is). */
export const MOTION_SCALE = 1.12;
/** Extra scale a "zoom" transition starts from. */
const ZOOM_FROM = 0.25;
/** The export samples a transition once per frame of its 30 fps grid. */
export const FPS = 30;

/** What a clip looks like at one instant: opacity, horizontal offset in % of the frame width, and scale. */
export interface ClipFrame {
  opacity: number;
  x: number;
  scale: number;
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
/** Same curve as GSAP's "power3.out", so the editor and the export agree. */
const easeOut = (p: number) => 1 - (1 - clamp01(p)) ** 3;

/** Seconds the transition of this clip lasts (0 for a cut). */
export function transitionLength(clip: Pick<EditClip, "transition" | "duration">): number {
  return clip.transition === "cut" ? 0 : Math.min(TRANSITION_SECONDS, clip.duration / 2);
}

/** The motion's scale at `progress` (0 to 1 over the clip). */
export function motionScale(motion: ClipMotion, progress: number): number {
  const q = clamp01(progress);
  if (motion === "push") return 1 + (MOTION_SCALE - 1) * q;
  if (motion === "pull") return MOTION_SCALE - (MOTION_SCALE - 1) * q;
  return 1;
}

/** The look of a clip at timeline time `t` (clamped to the clip's own span). Audio-only clips never call this. */
export function clipFrame(clip: Pick<EditClip, "start" | "duration" | "transition" | "motion">, t: number): ClipFrame {
  const local = Math.max(0, Math.min(clip.duration, t - clip.start));
  const length = transitionLength(clip);
  const e = length > 0 ? easeOut(local / length) : 1;
  const frame: ClipFrame = { opacity: 1, x: 0, scale: motionScale(clip.motion, local / clip.duration) };
  if (clip.transition === "fade") frame.opacity = e;
  else if (clip.transition === "slide") frame.x = (1 - e) * 100;
  else if (clip.transition === "zoom") { frame.opacity = e; frame.scale *= 1 + ZOOM_FROM * (1 - e); }
  return frame;
}

export interface ClipKeyframes {
  /** One instant per frame of the transition: set these values at this timeline time. */
  steps: { at: number; frame: ClipFrame }[];
  /** After the transition, the slow move: a straight tween of the scale. Null when the clip does not move. */
  tail: { at: number; duration: number; from: number; to: number } | null;
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/**
 * What the export has to play for a clip: the transition sampled per frame (so the transition and the slow move
 * never fight over the same property) and then the move as one linear tween.
 */
export function clipKeyframes(clip: Pick<EditClip, "start" | "duration" | "transition" | "motion">): ClipKeyframes {
  const length = transitionLength(clip);
  const steps: ClipKeyframes["steps"] = [];
  if (length > 0) {
    const count = Math.ceil(length * FPS);
    for (let i = 0; i <= count; i++) {
      const at = Math.min(length, i / FPS);
      // The frame is computed at the rounded time that is written out, so the export replays exactly this.
      const time = round(clip.start + at);
      steps.push({ at: time, frame: clipFrame(clip, time) });
    }
  }
  const from = clip.start + length;
  const left = clip.duration - length;
  const tail = clip.motion !== "none" && left > 0.001
    ? { at: round(from), duration: round(left), from: motionScale(clip.motion, length / clip.duration), to: motionScale(clip.motion, 1) }
    : null;
  return { steps, tail };
}

/** CSS for the editor's preview of a frame. */
export function frameStyle(frame: ClipFrame): { opacity: number; transform: string } {
  return { opacity: frame.opacity, transform: `translateX(${frame.x}%) scale(${frame.scale})` };
}

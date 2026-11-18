import { CLIP_MOTIONS, CLIP_TRANSITIONS, type ClipMotion, type ClipTransition } from "./motion";
import { clipSpeed, type EditClip, type EditDocument } from "./schema";

export const EFFECT_MOTIONS = [...CLIP_MOTIONS, "alternate"] as const;
export type EffectMotion = (typeof EFFECT_MOTIONS)[number];
export { CLIP_TRANSITIONS };

export interface EffectsRequest {
  /** Only these clips; default: every picture clip. */
  clipIds?: string[];
  transition?: ClipTransition;
  /** "alternate" pushes in on the 1st, 3rd... clip and pulls back on the 2nd, 4th... */
  motion?: EffectMotion;
  /** Playback speed (0.25 to 4). The clip keeps its place and length on the timeline (shortened if the file runs out). */
  speed?: number;
}

/** Contiguous pieces of one shot (same file, source continues where the last piece ended) must not get a transition between them. */
function continuesShot(prev: EditClip | undefined, clip: EditClip): boolean {
  return !!prev && prev.assetId === clip.assetId && Math.abs(prev.in + prev.duration * clipSpeed(prev) - clip.in) < 0.1 && Math.abs(prev.start + prev.duration - clip.start) < 0.1;
}

/**
 * Sets the arrival transition and the slow camera move on the picture clips of a montage, in one go. The first
 * clip has nothing to arrive from, so it stays a cut, and so does a clip that just continues the shot of the
 * one before it (a cut in the middle of a take), unless the caller named the clip.
 */
export function applyClipEffects(doc: EditDocument, request: EffectsRequest): { doc: EditDocument; changed: number } {
  const picture = doc.clips
    .filter((c) => {
      const kind = doc.assets.find((a) => a.id === c.assetId)?.kind;
      return kind === "video" || kind === "image";
    })
    .sort((a, b) => a.start - b.start);
  const named = request.clipIds ? new Set(request.clipIds) : null;
  const patches = new Map<string, Partial<Pick<EditClip, "transition" | "motion" | "speed" | "duration">>>();
  picture.forEach((clip, index) => {
    if (named && !named.has(clip.id)) return;
    const patch: Partial<Pick<EditClip, "transition" | "motion" | "speed" | "duration">> = {};
    if (request.transition) patch.transition = index === 0 || (!named && continuesShot(picture[index - 1], clip)) ? "cut" : request.transition;
    if (request.motion) patch.motion = (request.motion === "alternate" ? (index % 2 === 0 ? "push" : "pull") : request.motion) as ClipMotion;
    if (request.speed !== undefined) {
      const asset = doc.assets.find((a) => a.id === clip.assetId);
      const speed = Math.max(0.25, Math.min(4, request.speed));
      patch.speed = speed === 1 ? undefined : speed;
      // Same place and length on the timeline; a file that runs out at the new speed shortens the clip.
      if (asset?.kind === "video") patch.duration = Math.max(0.04, Math.min(clip.duration, Math.floor(((asset.duration - clip.in + 0.04) / speed) * 30) / 30));
    }
    const speedChanged = request.speed !== undefined && (clipSpeed(clip) !== (patch.speed ?? 1) || (patch.duration !== undefined && Math.abs(patch.duration - clip.duration) > 0.001));
    if ((patch.transition && patch.transition !== clip.transition) || (patch.motion && patch.motion !== clip.motion) || speedChanged) patches.set(clip.id, patch);
  });
  if (patches.size === 0) return { doc, changed: 0 };
  return { doc: { ...doc, enabled: true, clips: doc.clips.map((c) => { const patch = patches.get(c.id); if (!patch) return c; const merged = { ...c, ...patch }; if (merged.speed === undefined) delete merged.speed; return merged; }) }, changed: patches.size };
}

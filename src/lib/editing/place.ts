import { musicClipDefaults, pictureEnd } from "./music";
import { editDuration, type EditAsset, type EditClip, type EditDocument } from "./schema";

const round = (n: number) => Math.round(n * 1000) / 1000;

/** How long a still image stays on screen when it is added to the timeline. */
export const IMAGE_SECONDS = 5;

/**
 * Puts an imported asset (already in `doc.assets`) on the timeline.
 * Videos and images go one after the other, in the order they are added.
 * Audio becomes the music bed from the start, cut to the length of the
 * picture so far (so add it after the visuals) and quiet under a voice.
 * Documents are reference material and stay off the timeline.
 */
export function placeAsset(doc: EditDocument, asset: EditAsset): EditDocument {
  if (asset.kind === "document") return doc;
  const music = asset.kind === "audio" ? musicClipDefaults(doc, asset, 0) : null;
  const clip: EditClip = {
    id: crypto.randomUUID(),
    assetId: asset.id,
    start: music ? 0 : round(pictureEnd(doc)),
    in: 0,
    duration: music?.duration ?? (asset.kind === "image" ? IMAGE_SECONDS : asset.duration),
    volume: music?.volume ?? 1,
    fit: "contain",
    transition: "cut",
    motion: "none",
  };
  const next = { ...doc, enabled: true, clips: [...doc.clips, clip] };
  // The montage is as long as what is on it, not the 15 s placeholder of an empty document.
  return { ...next, duration: editDuration({ ...next, duration: 0.1 }) };
}

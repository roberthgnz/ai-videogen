import { t as translate } from "@/lib/i18n";
import { IMAGE_SECONDS } from "./place";
import { pictureEnd } from "./music";
import { captionsForClips, editDuration, type EditClip, type EditDocument, type EditOverlay } from "./schema";

/** One piece of the final cut, in the order it should play. */
export interface Segment {
  assetId: string;
  /** Where in the source file it starts (s). Default 0. */
  in?: number;
  /** How long it plays on the timeline (s). Default: from `in` to the end of the file (images: 5 s). */
  duration?: number;
  /** Playback speed, 0.25 to 4 (default 1): a piece of `duration` s uses `duration * speed` s of the file. */
  speed?: number;
  volume?: number;
  fit?: EditClip["fit"];
}

export interface ArrangeOptions {
  /** The picture should last about this long (s): pieces are trimmed from their end, longest first, to fit. */
  targetDuration?: number;
  /** Shot changes (s) per asset: starts and ends within SNAP of one move onto it, so no piece starts or ends mid-motion. */
  shots?: Record<string, number[]>;
  /** Remove every text and subtitle instead of moving subtitles with their pieces. */
  clearTexts?: boolean;
}

export interface ArrangeResult {
  doc: EditDocument;
  /** Length of the picture (s). */
  picture: number;
  /** Things the caller should tell the user. */
  notes: string[];
}

/** Starts and ends this close to a shot change move onto it. */
export const SNAP = 0.35;
/** A piece is never trimmed below this to fit a target (s). */
export const MIN_PIECE = 0.8;
const FPS = 30;
const frames = (s: number) => Math.round(s * FPS) / FPS;
const round3 = (n: number) => Math.round(n * 1000) / 1000;

function snap(t: number, changes: number[] | undefined): number {
  if (!changes?.length) return t;
  let best = t, bestDistance = SNAP;
  for (const c of changes) if (Math.abs(c - t) <= bestDistance) { best = c; bestDistance = Math.abs(c - t); }
  return best;
}

/**
 * Moves the subtitles of the old order to the new one. Each subtitle is tied to the clip it sat over (the one with
 * the most overlap), which gives its position in the SOURCE file; the new clips of that file then say where that
 * speech plays now. Subtitles over no clip, or whose speech is no longer used, disappear; the counts say how many.
 */
export function followCaptions(doc: EditDocument, newClips: EditClip[]): { captions: EditOverlay[]; kept: number; lost: number } {
  const picture = doc.clips.filter((c) => doc.assets.find((a) => a.id === c.assetId)?.kind === "video");
  const cues = new Map<string, EditOverlay[]>();
  const seen = new Set<string>();
  let lost = 0;
  for (const caption of doc.overlays.filter((o) => o.kind === "caption")) {
    let best: EditClip | undefined, bestOverlap = 0;
    for (const clip of picture) {
      const overlap = Math.min(caption.start + caption.duration, clip.start + clip.duration) - Math.max(caption.start, clip.start);
      // Ties go to a clip with sound: that is where the words come from.
      const voiced = doc.assets.find((a) => a.id === clip.assetId)?.hasAudio ? 1e-6 : 0;
      if (overlap + voiced > bestOverlap) { best = clip; bestOverlap = overlap + voiced; }
    }
    if (!best || bestOverlap <= 0.001) { lost++; continue; }
    const speed = best.speed ?? 1;
    const start = best.in + (caption.start - best.start) * speed;
    const key = `${best.assetId}|${Math.round(start * 20)}|${caption.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    cues.set(best.assetId, [...(cues.get(best.assetId) ?? []), { ...caption, start, duration: caption.duration * speed, id: crypto.randomUUID() }]);
  }
  const moved: EditOverlay[] = [];
  for (const [assetId, list] of cues) {
    const clips = newClips.filter((c) => c.assetId === assetId);
    for (const cue of list) {
      const pieces = captionsForClips([cue], clips);
      if (pieces.length === 0) lost++;
      moved.push(...pieces);
    }
  }
  moved.sort((a, b) => a.start - b.start);
  return { captions: moved, kept: moved.length, lost };
}

/**
 * Lays the given pieces of the project's videos and images one after another, in order, with exact start
 * times on the 30 fps grid. Replaces every picture clip; music and other audio stay, with a music bed
 * (a track that ran along the old picture) cut or stretched to the new picture. Subtitles follow the speech
 * they belong to (see `followCaptions`); other texts stay where they are, with a warning, unless `clearTexts`.
 */
export function arrangeClips(doc: EditDocument, segments: Segment[], options: ArrangeOptions = {}): ArrangeResult {
  const notes: string[] = [];
  const oldEnd = pictureEnd(doc);

  const pieces = segments.map((segment, index) => {
    const asset = doc.assets.find((a) => a.id === segment.assetId);
    if (!asset || (asset.kind !== "video" && asset.kind !== "image")) throw new Error(translate("The piece {0} uses \"{1},\" which is not a project video or image (look at the id in \"Available Files\").", index + 1, segment.assetId));
    if (asset.kind === "image") return { segment, asset, start: 0, speed: 1, length: segment.duration ?? IMAGE_SECONDS };
    const speed = Math.max(0.25, Math.min(4, segment.speed ?? 1));
    const max = Math.max(0.1, asset.duration);
    let start = Math.max(0, Math.min(segment.in ?? 0, max - 0.2));
    let end = Math.min(max, start + (segment.duration !== undefined ? segment.duration * speed : max - start));
    const changes = options.shots?.[asset.id];
    const snappedStart = snap(start, changes), snappedEnd = snap(end, changes);
    // Only follow a shot change when what is left is still a real piece.
    if (snappedEnd - snappedStart >= 0.5) { start = snappedStart; end = Math.min(max, snappedEnd); }
    return { segment, asset, start, speed, length: (end - start) / speed };
  });

  const target = options.targetDuration;
  const total = () => pieces.reduce((sum, p) => sum + p.length, 0);
  if (target && total() > target + 0.05) {
    // Trim the longest pieces first, a little at a time, so the cut stays balanced and no piece falls under MIN_PIECE.
    for (let guard = 0; guard < 5000 && total() > target + 0.05; guard++) {
      const trimmable = pieces.filter((p) => p.length > MIN_PIECE + 0.001);
      if (!trimmable.length) break;
      const longest = trimmable.reduce((a, b) => (b.length > a.length ? b : a));
      longest.length = Math.max(MIN_PIECE, longest.length - Math.min(0.1, total() - target));
    }
    if (total() > target + 0.05) notes.push(translate("It does not fit in {0} s without leaving pieces of less than {1} s: it remains in {2}. Remove pieces if you want to shorten more.", target, MIN_PIECE, total().toFixed(1)));
  } else if (target && total() < target - 1) {
    notes.push(translate("It remains in {0} s, below the {1} s orders: there is no more material in those pieces.", total().toFixed(1), target));
  }

  let cursor = 0;
  const picture: EditClip[] = pieces.map(({ segment, asset, start, speed, length }) => {
    const previous = doc.clips.find((c) => c.assetId === asset.id && c.fit);
    // What the file has left, as timeline seconds at this speed (plus the schema's 0.04 s slack, in file seconds).
    const room = asset.kind === "image" ? length : Math.max(0, asset.duration - start + 0.04) / speed;
    // Whole frames, never longer than the file has left (the schema allows a 0.05 s slack: stay inside it).
    const duration = Math.max(2 / FPS, Math.min(frames(length), Math.floor(room * FPS) / FPS));
    const clip: EditClip = {
      id: crypto.randomUUID(), assetId: asset.id, start: round3(cursor), in: round3(asset.kind === "image" ? 0 : start), duration: round3(duration),
      volume: segment.volume ?? 1, fit: segment.fit ?? previous?.fit ?? "contain", transition: "cut", motion: "none",
      ...(speed !== 1 ? { speed } : {}),
    };
    cursor = frames(cursor + duration);
    return clip;
  });
  const newEnd = cursor;

  // A music bed ran along the old picture: make it run along the new one.
  const others = doc.clips.filter((c) => doc.assets.find((a) => a.id === c.assetId)?.kind === "audio").map((c) => {
    const asset = doc.assets.find((a) => a.id === c.assetId)!;
    const wasBed = c.start < 0.05 && oldEnd > 0 && Math.abs(c.start + c.duration - oldEnd) < 0.5;
    // A track from the start that would now play on past the picture is cut there: the montage must not end in black.
    const runsLong = c.start < 0.05 && c.start + c.duration > newEnd + 0.05;
    if (!wasBed && !runsLong) return c;
    const duration = Math.max(2 / FPS, Math.min(newEnd - c.start, asset.duration - c.in));
    if (runsLong && duration < c.duration - 0.05) notes.push(translate("I've cut the music to get the image done."));
    return { ...c, duration: round3(duration) };
  });

  const oldCaptions = doc.overlays.filter((o) => o.kind === "caption");
  const texts = doc.overlays.filter((o) => o.kind !== "caption");
  let overlays = doc.overlays;
  if (options.clearTexts) {
    overlays = [];
    if (doc.overlays.length) notes.push(translate("I have removed {0} texts and subtitles.", doc.overlays.length));
  } else {
    const followed = oldCaptions.length ? followCaptions(doc, picture) : { captions: [], kept: 0, lost: 0 };
    overlays = [...texts, ...followed.captions].sort((a, b) => a.start - b.start);
    if (oldCaptions.length) notes.push(translate("Subtitles: {0} now go with your video piece {1}.", followed.kept, followed.lost ? translate("; {0} of those from before do not come out anymore because their audio is not in the new assembly", followed.lost) : ""));
    if (texts.length) notes.push(translate("The {0} loose texts are still in their previous times and may not match the new order: review them or corral them.", texts.length));
  }

  const next: EditDocument = { ...doc, enabled: true, clips: [...picture, ...others], overlays };
  return { doc: { ...next, duration: editDuration({ ...next, duration: 0.1 }) }, picture: round3(newEnd), notes };
}

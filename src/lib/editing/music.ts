import { t as translate } from "@/lib/i18n";
import { editDuration, isNarrationName, type EditAsset, type EditClip, type EditDocument } from "./schema";

const round = (n: number) => Math.round(n * 1000) / 1000;

/** Level of a music bed under a voice (the clip volume slider can change it). */
export const MUSIC_VOLUME_UNDER_SPEECH = 0.22;

const assetOf = (doc: EditDocument, clip: EditClip): EditAsset | undefined => doc.assets.find((a) => a.id === clip.assetId);

/** Whether a file is a narration (a voice-over, the voice of a script's scene) rather than music. */
export const isNarration = (asset: Pick<EditAsset, "kind" | "name">) => asset.kind === "audio" && isNarrationName(asset.name);

/** Clips that carry a voice: audible video with its own audio track, or a narration. */
export function speechClips(doc: EditDocument): EditClip[] {
  return doc.clips.filter((c) => {
    const asset = assetOf(doc, c);
    return !!asset && c.volume > 0 && (asset.kind === "video" ? asset.hasAudio : isNarration(asset));
  });
}

/** Where the picture ends: the last video or image clip. 0 when there is none. */
export function pictureEnd(doc: EditDocument): number {
  return Math.max(0, ...doc.clips.filter((c) => assetOf(doc, c)?.kind !== "audio").map((c) => c.start + c.duration));
}

/**
 * A new music clip: as long as the picture (never longer than the track, so
 * the montage does not grow into black), and quiet when there is a voice.
 */
export function musicClipDefaults(doc: EditDocument, track: Pick<EditAsset, "duration">, start: number): { duration: number; volume: number } {
  const end = pictureEnd(doc);
  const room = end > start ? end - start : track.duration;
  return {
    duration: round(Math.max(0.04, Math.min(track.duration, room))),
    volume: speechClips(doc).length ? MUSIC_VOLUME_UNDER_SPEECH : 1,
  };
}

/** Typical beat interval of a track (median of the gaps, which ignores a missed or doubled beat). */
export function beatPeriod(beats: number[]): number {
  const gaps = beats.slice(1).map((b, i) => b - beats[i]).filter((g) => g > 0.05).sort((a, b) => a - b);
  if (gaps.length === 0) throw new Error(translate("A stable rhythm was not detected in this audio."));
  return gaps[Math.floor(gaps.length / 2)];
}

/** Distance from `t` to the closest of the sorted `beats`. */
function nearest(beats: number[], t: number): number {
  let lo = 0;
  let hi = beats.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (beats[mid] < t) lo = mid;
    else hi = mid;
  }
  return Math.min(Math.abs(beats[lo] - t), Math.abs(beats[hi] - t));
}

export interface MusicSync {
  doc: EditDocument;
  /** "shift": the music moved under untouched clips. "retime": the clips moved onto the beats. */
  mode: "shift" | "retime";
  bpm: number;
  /** Mean distance (seconds) between a cut and the closest beat, before and after. */
  before: number;
  after: number;
  /** Volume was lowered to sit under the voice. */
  ducked: boolean;
}

/** Mean distance from the cuts to the beat grid when the track starts `offset` seconds in. */
function gridCost(beats: number[], cuts: { t: number; weight: number }[], music: EditClip, offset: number): number {
  let total = 0;
  let weights = 0;
  for (const cut of cuts) {
    total += cut.weight * nearest(beats, offset + (cut.t - music.start));
    weights += cut.weight;
  }
  return total / weights;
}

/**
 * Syncs a music clip with the montage.
 *
 * With a voice on the timeline nothing the voice says may move: clips and
 * captions stay exactly where they are and the music slides (its start point
 * inside the track) to the phase where its beats fall closest to the cuts, the
 * first cut counting triple so the music hits with the picture. Without a
 * voice (b-roll, images) the clips are free to move, so each cut is snapped to
 * the closest beat instead, in order, keeping every clip at its own length
 * within a beat.
 */
export function syncMusic(doc: EditDocument, music: EditClip, beats: number[], bpm: number | null = null): MusicSync {
  const asset = assetOf(doc, music);
  if (!asset || asset.kind !== "audio") throw new Error(translate("Select a music clip."));
  const sorted = [...beats].sort((a, b) => a - b);
  const period = beatPeriod(sorted);
  const tempo = bpm ?? 60 / period;
  const visuals = doc.clips.filter((c) => assetOf(doc, c)?.kind !== "audio").sort((a, b) => a.start - b.start);
  if (visuals.length === 0) throw new Error(translate("Add a video or images to the timeline before synchronizing the music."));
  const cuts = visuals.filter((c) => c.start >= music.start - 0.001).map((c, i) => ({ t: c.start, weight: i === 0 ? 3 : 1 }));
  const before = gridCost(sorted, cuts, music, music.in);

  if (speechClips(doc).length > 0) {
    // Slide the track over one beat period (plus the whole beats it already skips) and keep the best phase.
    const steps = 48;
    let best = { offset: music.in, cost: before };
    const base = Math.max(0, music.in - period * 2);
    for (let i = 0; i <= steps * 4; i++) {
      const offset = base + (i * period) / steps;
      if (offset + 0.04 > asset.duration) break;
      const cost = gridCost(sorted, cuts, music, offset);
      if (cost < best.cost - 1e-9) best = { offset, cost };
    }
    const volume = music.volume > MUSIC_VOLUME_UNDER_SPEECH ? MUSIC_VOLUME_UNDER_SPEECH : music.volume;
    // The music never plays on past the picture, and the montage is as long as what is on it.
    const picture = pictureEnd(doc);
    const room = picture > music.start ? picture - music.start : music.duration;
    const moved: EditClip = {
      ...music,
      in: round(best.offset),
      duration: round(Math.max(0.04, Math.min(music.duration, asset.duration - best.offset, room))),
      volume,
    };
    const clips = doc.clips.map((c) => (c.id === music.id ? moved : c));
    const fitted = Math.abs(doc.duration - editDuration(doc)) < 0.05;
    return {
      doc: { ...doc, enabled: true, clips, duration: fitted ? Math.max(0.1, editDuration({ ...doc, clips, duration: 0.1 })) : doc.duration },
      mode: "shift",
      bpm: tempo,
      before,
      after: best.cost,
      ducked: volume !== music.volume,
    };
  }

  // Free clips: snap each cut to the beat closest to where it would have fallen.
  const beatTimes = sorted.map((t) => music.start + t - music.in).filter((t) => t >= music.start && t < music.start + music.duration);
  const retimed = new Map<string, EditClip>();
  let cursor = music.start;
  for (const c of visuals) {
    const source = assetOf(doc, c)!;
    const desired = Math.min(c.duration, source.kind === "image" ? c.duration : (source.duration - c.in) / (c.speed ?? 1));
    const candidates = beatTimes.filter((t) => t > cursor + 0.25 && t <= cursor + desired + period / 2);
    const target = cursor + desired;
    const end = candidates.length ? candidates.reduce((a, b) => (Math.abs(b - target) < Math.abs(a - target) ? b : a)) : target;
    const length = round(Math.min(end - cursor, source.kind === "image" ? 7200 : (source.duration - c.in) / (c.speed ?? 1)));
    retimed.set(c.id, { ...c, start: round(cursor), duration: length });
    cursor = round(cursor + length);
  }
  const next = { ...doc, enabled: true, clips: doc.clips.map((c) => retimed.get(c.id) ?? c) };
  const after = gridCost(sorted, [...retimed.values()].map((c, i) => ({ t: c.start, weight: i === 0 ? 3 : 1 })), music, music.in);
  return { doc: { ...next, duration: Math.max(next.duration, editDuration(next)) }, mode: "retime", bpm: tempo, before, after, ducked: false };
}

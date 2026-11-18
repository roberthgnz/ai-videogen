import { t as translate } from "@/lib/i18n";
/**
 * The thinking half of the editing harness, with no file or network access: how a continuous clip splits into
 * moments, which order the clips were filmed in, and how a storyboard of moments becomes exact cuts plus the
 * warnings an editor would raise (going back in a clip, ping-pong between clips, reused footage).
 */
import type { Segment } from "./arrange";

/** One stretch of a clip that reads as a single unit: between two camera moves or shot changes. */
export interface Moment {
  /** "C3.M2": clip 3 in filming order, its second moment. */
  id: string;
  assetId: string;
  from: number;
  to: number;
  /** The steadiest second inside it (its keyframe). */
  best: number;
  /** Mean frame-to-frame change (0-1); handheld phone footage sits around 0.01-0.06. */
  motion: number;
  /** What happens, in a few words (from the vision pass), when known. */
  description?: string;
  /** Text or numbers readable in the frame ("3/6", a sign). */
  visibleText?: string;
  quality?: "buena" | "movida" | "borrosa" | "oscura" | "tapada";
}

export interface FootageClip {
  /** "C3" for material, "R1" for a reference. */
  label: string;
  assetId: string;
  name: string;
  kind: "video" | "image";
  duration: number;
  /** When it was filmed (ms since epoch), from the file's metadata or name; null when unknown. */
  capturedAt: number | null;
  reference: boolean;
  summary?: string;
  moments: Moment[];
}

export interface MotionSample { t: number; score: number }

const MIN_MOMENT = 1.2;
const MAX_MOMENT = 6;
const HARD_CUT = 0.3;

/** Filming time from names like "WhatsApp Video 2026-11-11 at 20.05.36", "VID_20261111_200536", "PXL_20261111_200536123". */
export function captureTimeFromName(name: string): number | null {
  const patterns: RegExp[] = [
    /(\d{4})-(\d{2})-(\d{2})\D{1,5}(\d{1,2})[.:h](\d{2})[.:m](\d{2})/,
    /(\d{4})(\d{2})(\d{2})[_-](\d{2})(\d{2})(\d{2})/,
  ];
  for (const pattern of patterns) {
    const m = name.match(pattern);
    if (!m) continue;
    const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number);
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) continue;
    // "(1)", "(2)": copies made in the same second keep their order.
    const copy = Number(name.match(/\((\d+)\)/)?.[1] ?? 0);
    return Date.UTC(y, mo - 1, d, h, mi, s) + copy;
  }
  return null;
}

function smooth(samples: MotionSample[], radius = 2): number[] {
  return samples.map((_, i) => {
    let sum = 0, n = 0;
    for (let j = Math.max(0, i - radius); j <= Math.min(samples.length - 1, i + radius); j++) { sum += samples[j].score; n++; }
    return n ? sum / n : 0;
  });
}

/**
 * Splits a clip into moments: at hard shot changes, then long stretches at their biggest camera move (or in even
 * parts when the clip is uniformly steady), until each lasts at most MAX_MOMENT. Each moment's `best` is the
 * centre of its steadiest second.
 */
export function segmentMoments(duration: number, samples: MotionSample[]): { from: number; to: number; best: number; motion: number }[] {
  if (duration <= 0) return [];
  if (!samples.length) return evenSplit(0, duration).map(([from, to]) => ({ from, to, best: (from + to) / 2, motion: 0 }));
  const smoothed = smooth(samples);
  const at = (from: number, to: number) => samples.map((s, i) => ({ t: s.t, m: smoothed[i] })).filter((s) => s.t >= from && s.t < to);
  const cuts = samples.filter((s) => s.score > HARD_CUT && s.t > MIN_MOMENT / 2 && s.t < duration - MIN_MOMENT / 2).map((s) => s.t);
  const bounds = [0, ...cuts.filter((t, i) => i === 0 || t - cuts[i - 1] >= MIN_MOMENT), duration];

  const ranges: [number, number][] = [];
  const split = (from: number, to: number) => {
    if (to - from <= MAX_MOMENT) { ranges.push([from, to]); return; }
    const inner = at(from + MIN_MOMENT, to - MIN_MOMENT);
    const values = inner.map((s) => s.m).sort((a, b) => a - b);
    const median = values[Math.floor(values.length / 2)] ?? 0;
    const peak = inner.reduce<{ t: number; m: number } | null>((best, s) => (!best || s.m > best.m ? s : best), null);
    // A real camera move stands out from the rest of the clip; otherwise cut it in even parts.
    if (peak && peak.m > Math.max(median * 1.6, median + 0.01)) { split(from, peak.t); split(peak.t, to); }
    else for (const [a, b] of evenSplit(from, to)) ranges.push([a, b]);
  };
  for (let i = 0; i < bounds.length - 1; i++) split(bounds[i], bounds[i + 1]);

  // A sliver left between two cuts joins its neighbour.
  const merged: [number, number][] = [];
  for (const r of ranges) {
    const last = merged.at(-1);
    if (last && (r[1] - r[0] < MIN_MOMENT || last[1] - last[0] < MIN_MOMENT)) last[1] = r[1];
    else merged.push([...r]);
  }
  return merged.map(([from, to]) => {
    const inside = at(from, to);
    const motion = inside.length ? inside.reduce((s, x) => s + x.m, 0) / inside.length : 0;
    let best = (from + to) / 2, bestMotion = Infinity;
    for (const s of inside) {
      const window = inside.filter((x) => Math.abs(x.t - s.t) <= 0.5);
      const mean = window.reduce((a, x) => a + x.m, 0) / Math.max(1, window.length);
      if (s.t - from >= 0.4 && to - s.t >= 0.4 && mean < bestMotion) { bestMotion = mean; best = s.t; }
    }
    return { from: round(from), to: round(to), best: round(best), motion: round(motion, 4) };
  });
}

function evenSplit(from: number, to: number): [number, number][] {
  const parts = Math.max(1, Math.round((to - from) / 4));
  const step = (to - from) / parts;
  return Array.from({ length: parts }, (_, i) => [round(from + i * step), round(i === parts - 1 ? to : from + (i + 1) * step)] as [number, number]);
}

/** Clips in the order they were filmed (known times first, then by name), labelled C1, C2… and references R1, R2… */
export function orderClips<T extends { assetId: string; name: string; capturedAt: number | null; reference: boolean }>(clips: T[]): (T & { label: string })[] {
  const byTime = (a: T, b: T) => (a.capturedAt ?? Infinity) - (b.capturedAt ?? Infinity) || a.name.localeCompare(b.name, "es", { numeric: true });
  const material = clips.filter((c) => !c.reference).sort(byTime).map((c, i) => ({ ...c, label: `C${i + 1}` }));
  const references = clips.filter((c) => c.reference).sort(byTime).map((c, i) => ({ ...c, label: `R${i + 1}` }));
  return [...material, ...references];
}

export interface StoryShot {
  moment: string;
  /** Seconds on the timeline. Default: the moment's natural length, 1.2 to 4 s. */
  seconds?: number;
  /** Which part of the moment: its steadiest stretch (default), its start, its end, or all of it. */
  part?: "best" | "start" | "end" | "whole";
  speed?: number;
}

export interface StoryBeat { name: string; shots: StoryShot[] }

export interface ResolvedShot { beat: string; moment: Moment; clip: FootageClip; segment: Segment & { in: number; duration: number } }

/** Turns a storyboard of moment ids into exact pieces of the files, plus an editor's warnings. Throws on unknown ids. */
export function resolveStoryboard(clips: FootageClip[], beats: StoryBeat[], options: { allowRewind?: boolean; imageSeconds?: number; expectedShotSeconds?: number } = {}): { shots: ResolvedShot[]; warnings: string[] } {
  const moments = new Map(clips.flatMap((c) => c.moments.map((m) => [m.id.toUpperCase(), { moment: m, clip: c }] as const)));
  const shots: ResolvedShot[] = [];
  for (const beat of beats) {
    for (const shot of beat.shots) {
      const found = moments.get(shot.moment.trim().toUpperCase());
      if (!found) {
        const clip = clips.find((c) => shot.moment.toUpperCase().startsWith(`${c.label}.`));
        throw new Error(`No existe el momento «${shot.moment}».${clip ? ` Los de ${clip.label} son: ${clip.moments.map((m) => m.id).join(", ")}.` : translate(" Use the material record ids (e.g. C3.M2).")}`);
      }
      if (found.clip.reference) throw new Error(translate("\"{0}\" is a reference: it guides the style, but does not enter the assembly.", shot.moment));
      const { moment, clip } = found;
      const speed = Math.max(0.25, Math.min(4, shot.speed ?? 1));
      if (clip.kind === "image") {
        shots.push({ beat: beat.name, moment, clip, segment: { assetId: clip.assetId, in: 0, duration: shot.seconds ?? options.imageSeconds ?? 2.5 } });
        continue;
      }
      const span = moment.to - moment.from;
      const part = shot.part ?? "best";
      const wanted = part === "whole" ? span / speed : Math.max(0.15, shot.seconds ?? Math.min(4, Math.max(MIN_MOMENT, span)) / speed);
      const source = Math.min(span, wanted * speed);
      const start = part === "start" || part === "whole" ? moment.from
        : part === "end" ? moment.to - source
        : Math.min(moment.to - source, Math.max(moment.from, moment.best - source / 2));
      shots.push({ beat: beat.name, moment, clip, segment: { assetId: clip.assetId, in: round(start), duration: round(source / speed), ...(speed !== 1 ? { speed } : {}) } });
    }
  }
  if (!shots.length) throw new Error(translate("The visual script has no plane."));
  return { shots, warnings: storyboardWarnings(clips, shots, options.allowRewind ?? false, options.expectedShotSeconds) };
}

/** What a careful editor would flag for the agent to fix or justify. */
export function storyboardWarnings(clips: FootageClip[], shots: ResolvedShot[], allowRewind: boolean, expectedShotSeconds?: number): string[] {
  const warnings: string[] = [];
  const order = new Map(clips.filter((c) => !c.reference).map((c, i) => [c.assetId, i]));

  // Going back inside one clip: the action runs backwards on screen.
  if (!allowRewind) {
    const rewinds: string[] = [];
    const lastEnd = new Map<string, { end: number; id: string }>();
    for (const s of shots) {
      const previous = lastEnd.get(s.clip.assetId);
      if (previous && s.segment.in < previous.end - 0.1) rewinds.push(translate("{0} goes after {1} but it happens before in the clip", s.moment.id, previous.id));
      lastEnd.set(s.clip.assetId, { end: s.segment.in + s.segment.duration * (s.segment.speed ?? 1), id: s.moment.id });
    }
    if (rewinds.length) warnings.push(translate("Back into the same clip (action goes backwards): {0} {1}. Order them as they happen or justify the jump.", rewinds.slice(0, 4).join("; "), rewinds.length > 4 ? "…" : ""));
  }

  // The same footage twice.
  const reused = new Set<string>();
  for (let i = 0; i < shots.length; i++) for (let j = 0; j < i; j++) {
    const a = shots[i].segment, b = shots[j].segment;
    if (a.assetId === b.assetId && a.in < b.in + b.duration * (b.speed ?? 1) - 0.05 && b.in < a.in + a.duration * (a.speed ?? 1) - 0.05) reused.add(shots[i].moment.id);
  }
  if (reused.size) warnings.push(translate("Repeated material: {0} reuses image that has already come out.", [...reused].join(", ")));

  // Jumping back in filming order (the first shot, a hook, may come from the end on purpose).
  let backwards = 0;
  for (let i = 2; i < shots.length; i++) {
    const a = order.get(shots[i - 1].clip.assetId) ?? 0, b = order.get(shots[i].clip.assetId) ?? 0;
    if (b < a) backwards++;
  }
  if (backwards >= 2) warnings.push(translate("The assembly goes back in the recording order {0} times. People record in the order in which things happen: if history does not ask for another order (before / after, result first), follow C1 → C2 →…", backwards));

  // Ping-pong: A, B, A, B.
  let pingPong = 0;
  for (let i = 2; i < shots.length; i++) if (shots[i].clip.assetId === shots[i - 2].clip.assetId && shots[i].clip.assetId !== shots[i - 1].clip.assetId) pingPong++;
  if (pingPong >= 2) warnings.push(translate("Back-and-forth jumps between clips ({0}): alternate without a reason disorienting. Group that of each clip unless it is an intentional parallel assembly.", pingPong));

  const minimum = expectedShotSeconds ? Math.min(0.7, expectedShotSeconds / 2) : 0.7;
  const tiny = shots.filter((s) => s.segment.duration < minimum).map((s) => s.moment.id);
  if (tiny.length) warnings.push(translate("Plane of less than {0} s ({1}): check that they are understood according to the requested rate.", minimum.toFixed(2), tiny.join(", ")));
  const shaky = shots.filter((s) => s.moment.quality && s.moment.quality !== "buena").map((s) => `${s.moment.id} (${s.moment.quality})`);
  if (shaky.length) warnings.push(translate("Moments with image problems: {0}. If there is an alternative, change them.", shaky.join(", ")));
  return warnings;
}

/** The footage log as the agent reads it: clips in filming order, each moment with its id, time and content. */
export function describeFootage(clips: FootageClip[]): string {
  if (!clips.length) return "";
  const time = (ms: number | null) => (ms === null ? "hora desconocida" : new Date(ms).toISOString().slice(11, 19));
  const lines = [translate("FOOTAGE LOG (clips in recording order; mount with build_edit using the ids for the moment):")];
  for (const c of clips) {
    lines.push(`${c.label}${c.reference ? translate(" (REFERENCE: guide, not mounted)") : ""} «${c.name}» · ${c.kind === "image" ? "imagen" : `${c.duration.toFixed(1)} s`} · ${time(c.capturedAt)}${c.summary ? ` — ${c.summary}` : ""}`);
    for (const m of c.moments) {
      const bits = [m.description ?? translate("(without description)"), m.visibleText ? translate("text \"{0} '", m.visibleText) : "", m.quality && m.quality !== "buena" ? m.quality : ""].filter(Boolean);
      lines.push(`  ${m.id} ${c.kind === "image" ? "" : `${m.from.toFixed(1)}–${m.to.toFixed(1)} s `}${bits.join(" · ")}`);
    }
  }
  return lines.join("\n");
}

function round(n: number, digits = 2) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

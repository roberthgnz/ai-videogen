import type { WordTiming } from "@/lib/domain";

export interface DuckingLevels {
  /** Music level when nobody speaks (0-1). */
  full: number;
  /** Music level under the voice. */
  ducked: number;
  /** Seconds the music takes to go down before a phrase. */
  attack: number;
  /** Seconds it takes to come back up after one. */
  release: number;
}

export interface VolumePoint {
  /** Seconds from the start of the track. */
  t: number;
  /** Gain, 0-1. */
  v: number;
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Stretches of speech in absolute seconds. Pauses shorter than `minGap` are
 * bridged: the music should not pump up and down between sentences.
 */
export function speechSpans(
  scenes: { narrationStart: number; words: WordTiming[] }[],
  minGap: number,
): [number, number][] {
  const spans: [number, number][] = [];
  for (const scene of scenes) {
    if (scene.words.length === 0) continue;
    const start = scene.narrationStart + scene.words[0].start;
    const end = scene.narrationStart + Math.max(...scene.words.map((w) => Math.max(w.end, w.start)));
    const last = spans.at(-1);
    if (last && start - last[1] < minGap) last[1] = Math.max(last[1], end);
    else spans.push([start, end]);
  }
  return spans;
}

/**
 * Volume envelope for the music bed: full level in the silences, down just
 * before each phrase and back up after it. The first point sits at 0 so the
 * level before the first phrase is explicit.
 */
export function duckingPoints(spans: [number, number][], total: number, levels: DuckingLevels): VolumePoint[] {
  const points: VolumePoint[] = [];
  const add = (t: number, v: number) => {
    const time = round(Math.min(Math.max(t, 0), total));
    const last = points.at(-1);
    if (last && time <= last.t) {
      // Two changes at the same instant: the later one wins.
      if (time === last.t) last.v = v;
      return;
    }
    points.push({ t: time, v });
  };

  const first = spans[0];
  // Whether the music is at full level when the next phrase arrives.
  let up = !first || first[0] > levels.attack;
  add(0, up ? levels.full : levels.ducked);
  spans.forEach(([start, end], i) => {
    if (up) add(start - levels.attack, levels.full);
    add(start, levels.ducked);
    add(end, levels.ducked);
    const next = spans[i + 1];
    // Only rise if there is time to get up and back down before the next phrase.
    up = !next || next[0] - end >= levels.release + levels.attack;
    if (up) add(end + levels.release, levels.full);
  });
  return points;
}

import type { WordTiming } from "@/lib/domain";

export interface ShotSlot {
  /** Scene-local seconds. */
  start: number;
  duration: number;
}

export const SHOT_TARGET_SEC = 3;
export const SHOT_MIN_SEC = 2;
export const SHOT_MAX_SEC = 4;
/** How far a cut may move from its even position to land on a word. */
const SNAP_SEC = 0.6;
/** Shortest shot a snapped cut may leave. */
const MIN_AFTER_SNAP_SEC = 1.5;

const round = (n: number) => Math.round(n * 1000) / 1000;

/** How many 2-4 s shots a scene of this length gets. */
export function shotCount(sceneDuration: number): number {
  if (!(sceneDuration > 0)) return 1;
  let n = Math.max(1, Math.round(sceneDuration / SHOT_TARGET_SEC));
  while (sceneDuration / n > SHOT_MAX_SEC) n++;
  while (n > 1 && sceneDuration / n < SHOT_MIN_SEC) n--;
  return n;
}

/**
 * Splits a scene into back-to-back shots covering its whole duration. Cuts
 * start evenly spaced and move to the nearest word start (a cut on a word
 * reads as intentional; one mid-word reads as a glitch).
 * `wordStarts` are scene-local seconds. `maxCount` caps the number of shots
 * (e.g. to the assets actually available).
 */
export function planShots(sceneDuration: number, wordStarts: number[], maxCount = Infinity): ShotSlot[] {
  const n = Math.max(1, Math.min(shotCount(sceneDuration), maxCount));
  const cuts: number[] = [];
  for (let k = 1; k < n; k++) {
    const ideal = (k * sceneDuration) / n;
    const previous = cuts.at(-1) ?? 0;
    let best = ideal;
    let bestDistance = SNAP_SEC;
    for (const start of wordStarts) {
      const distance = Math.abs(start - ideal);
      if (distance < bestDistance && start - previous >= MIN_AFTER_SNAP_SEC && sceneDuration - start >= MIN_AFTER_SNAP_SEC) {
        best = start;
        bestDistance = distance;
      }
    }
    cuts.push(best);
  }
  const edges = [0, ...cuts, sceneDuration];
  return edges.slice(0, -1).map((start, i) => ({ start: round(start), duration: round(edges[i + 1] - start) }));
}

/** Word starts in scene time, for `planShots`. */
export function sceneWordStarts(words: WordTiming[], narrationStart: number): number[] {
  return words.map((w) => narrationStart + w.start);
}

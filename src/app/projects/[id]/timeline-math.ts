import { estimateSeconds } from "@/lib/script/schema";
import { theme } from "@/theme";

/**
 * Where each scene sits in the video, as the composer lays it out: lead +
 * narration + tail, back to back (src/lib/pipeline/composition sceneSlots).
 * The narration length is the real audio when it is up to date, an estimate
 * from the words otherwise.
 */
export interface Span {
  start: number;
  duration: number;
}

export function sceneSpans(narrationSeconds: number[]): Span[] {
  const pad = theme.timing.sceneLead + theme.timing.sceneTail;
  let t = 0;
  return narrationSeconds.map((n) => {
    const span = { start: t, duration: Math.max(0.5, n + pad) };
    t += span.duration;
    return span;
  });
}

/** Seconds of narration: the real take if it matches the text, else the estimate. */
export function narrationSeconds(narration: string, audio: { durationSec: number | null; upToDate: boolean } | undefined): number {
  if (audio?.upToDate && audio.durationSec != null) return audio.durationSec;
  return estimateSeconds(narration);
}

export function totalOf(spans: Span[]): number {
  const last = spans.at(-1);
  return last ? last.start + last.duration : 0;
}

/** Index of the scene playing at `t` (the last one past the end). -1 without scenes. */
export function sceneAt(spans: Span[], t: number): number {
  if (spans.length === 0) return -1;
  for (let i = 0; i < spans.length; i++) if (t < spans[i].start + spans[i].duration) return i;
  return spans.length - 1;
}

/** 00:07:12 style: minutes, seconds, hundredths. */
export function formatClock(t: number): string {
  const safe = Math.max(0, Number.isFinite(t) ? t : 0);
  const m = Math.floor(safe / 60);
  const s = Math.floor(safe % 60);
  const cs = Math.floor((safe * 100) % 100);
  return [m, s, cs].map((n) => String(n).padStart(2, "0")).join(":");
}

/** Ruler marks: every `step` seconds, a step that keeps labels at least ~56 px apart. */
export function rulerStep(pxPerSec: number): number {
  for (const step of [1, 2, 5, 10, 15, 30, 60]) if (step * pxPerSec >= 56) return step;
  return 120;
}

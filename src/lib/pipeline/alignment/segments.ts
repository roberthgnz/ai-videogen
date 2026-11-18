import type { WordTiming } from "@/lib/domain";
import type { WordSegment } from "../tts/types";

const HAS_WORD_CHAR = /[\p{L}\p{N}]/u;
const round = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Splits narration into the words shown as captions: whitespace-separated,
 * punctuation kept, and tokens without letters/digits glued to a neighbour.
 */
export function displayTokens(text: string): string[] {
  const raw = text.split(/\s+/u).filter(Boolean);
  const out: string[] = [];
  let prefix = "";
  for (const token of raw) {
    if (!HAS_WORD_CHAR.test(token)) {
      if (out.length) out[out.length - 1] += ` ${token}`;
      else prefix = prefix ? `${prefix} ${token}` : token;
      continue;
    }
    out.push(prefix ? `${prefix} ${token}` : token);
    prefix = "";
  }
  return out;
}

/** Comparable form: no accents, punctuation or case ("¿Qué?" -> "que", "I've" -> "ive"). */
export function normalizeWord(word: string): string {
  return word
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
}

function substitutionCost(a: string, b: string): number {
  if (a === b) return 0;
  if (a && b && (a.startsWith(b) || b.startsWith(a))) return 0.5;
  return 1;
}

/**
 * Maps provider word timings (normalized, possibly with numbers spelled out
 * or words split/merged) onto the original narration words, so captions show
 * the real text with real timings. Uses a minimum-edit alignment:
 * - matched/substituted segments give their time to that word,
 * - extra segments (e.g. "ciento" "cincuenta" for "150") extend the previous word,
 * - words with no segment are interpolated between their neighbours.
 */
export function wordsFromSegments(text: string, segments: WordSegment[]): WordTiming[] {
  const words = displayTokens(text);
  if (words.length === 0) return [];
  const segs = segments.filter((s) => normalizeWord(s.text) !== "");
  const a = words.map(normalizeWord);
  const b = segs.map((s) => normalizeWord(s.text));
  const n = a.length;
  const m = b.length;

  // cost[i][j] = min edits aligning a[0..i) with b[0..j)
  const cost: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = 1; i <= n; i++) cost[i][0] = i;
  for (let j = 1; j <= m; j++) cost[0][j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      cost[i][j] = Math.min(
        cost[i - 1][j - 1] + substitutionCost(a[i - 1], b[j - 1]),
        cost[i - 1][j] + 1, // word without segment
        cost[i][j - 1] + 1, // extra segment
      );
    }
  }

  // Backtrace: which segments belong to each word.
  const owned: number[][] = Array.from({ length: n }, () => []);
  const extras: { afterWord: number; seg: number }[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && cost[i][j] === cost[i - 1][j - 1] + substitutionCost(a[i - 1], b[j - 1])) {
      owned[i - 1].push(j - 1);
      i--;
      j--;
    } else if (j > 0 && (i === 0 || cost[i][j] === cost[i][j - 1] + 1)) {
      extras.push({ afterWord: i - 1, seg: j - 1 });
      j--;
    } else {
      i--;
    }
  }
  // An extra segment sits between word `afterWord` and the next one. Give it to the
  // neighbour that was not an exact match ("vibra [ciento] 150~cincuenta" -> 150).
  const exact = owned.map((idxs, k) => idxs.some((idx) => b[idx] === a[k]));
  for (const { afterWord, seg } of extras) {
    const next = afterWord + 1;
    const target =
      afterWord < 0 || (exact[afterWord] && next < n && !exact[next]) ? Math.min(next, n - 1) : afterWord;
    owned[target].push(seg);
  }

  const timed = words.map((word, k) => {
    const mine = owned[k].map((idx) => segs[idx]);
    return mine.length
      ? { word, start: Math.min(...mine.map((s) => s.start)), end: Math.max(...mine.map((s) => s.end)) }
      : { word, start: NaN, end: NaN };
  });

  // Interpolate words the provider skipped.
  for (let k = 0; k < timed.length; k++) {
    if (!Number.isNaN(timed[k].start)) continue;
    let next = k;
    while (next < timed.length && Number.isNaN(timed[next].start)) next++;
    const from = k > 0 ? timed[k - 1].end : 0;
    const to = next < timed.length ? timed[next].start : Math.max(from, segs.at(-1)?.end ?? from);
    const step = (to - from) / (next - k);
    for (let q = k; q < next; q++) {
      timed[q].start = from + step * (q - k);
      timed[q].end = from + step * (q - k + 1);
    }
    k = next - 1;
  }

  let lastStart = 0;
  return timed.map((t, k) => {
    const start = Math.max(lastStart, t.start, 0);
    const end = Math.max(start, t.end);
    lastStart = start;
    return { id: `w${k}`, text: t.word, start: round(start), end: round(end) };
  });
}

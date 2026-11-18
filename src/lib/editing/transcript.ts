import { getLocale, t as translate } from "@/lib/i18n";
import type { WordTiming } from "@/lib/domain";
import { normalizeWord } from "@/lib/pipeline/alignment/segments";
import { captionAppearanceSchema, clipSpeed, MIN_CAPTION, newOverlay, SILENCE_PAD, sourceSpan, type EditClip, type EditDocument, type EditOverlay } from "./schema";
import type { TranscriptCorrection, TranscriptCutKind, TranscriptProposal, TranscriptState } from "./transcript-schema";

/**
 * Editing a montage from what is said in it. A source file's words carry their seconds in the file (from
 * the transcription); a word is "in the montage" while some clip of that file plays it. Removing words cuts
 * that stretch out of every track and closes the gap; restoring puts the material back where it was.
 * Everything here is pure, so the studio (with its undo) and the assistant's tools share it.
 */

export type { WordTiming };
export interface SourceRange { from: number; to: number }
/** Audio level of a file every `step` seconds (RMS, dB) and the level under which it counts as quiet. */
export interface AudioEnergy { step: number; db: number[]; quiet: number }
interface Span { start: number; end: number }

/** Breath left on each side of a cut so words keep their attack and decay (~0.1 s, as in the silence autocut). */
export const CUT_MARGIN = SILENCE_PAD;
/** Pause between words worth proposing to cut. */
export const DEFAULT_PAUSE = 0.4;
/** Shortest cut worth making once the margins are left. */
const MIN_CUT = 0.15;
const LONGEST = 7200;

const round = (n: number) => Math.round(n * 1000) / 1000;
/** The export runs at 30 fps: cut edges sit on its frame grid, so neighbours share an edge exactly. */
const frame = (t: number) => Math.round(t * 30) / 30;
const clipsOf = (doc: EditDocument, assetId: string) => doc.clips.filter((c) => c.assetId === assetId);
const clipEnd = (c: EditClip) => c.in + sourceSpan(c);

function mergeSpans(spans: Span[]): Span[] {
  const sorted = spans.filter((s) => s.end - s.start > 0.001).sort((a, b) => a.start - b.start);
  const out: Span[] = [];
  for (const s of sorted) {
    const last = out.at(-1);
    if (last && s.start <= last.end + 0.001) last.end = Math.max(last.end, s.end);
    else out.push({ ...s });
  }
  return out;
}
const mergeRanges = (ranges: SourceRange[]): SourceRange[] => mergeSpans(ranges.map((r) => ({ start: r.from, end: r.to }))).map((s) => ({ from: s.start, to: s.end }));

// ---------------------------------------------------------------- dictionary of names and terms

/** Case and punctuation do not count; accents do («si» is not «sí»). */
const key = (text: string) => text.toLocaleLowerCase("es").replace(/[^\p{L}\p{N}]/gu, "");
const EDGES = /^([^\p{L}\p{N}]*)[\s\S]*?([^\p{L}\p{N}]*)$/u;
const fromKey = (from: string) => from.split(/\s+/).map(key).filter(Boolean).join(" ");

function rules(corrections: TranscriptCorrection[]) {
  return corrections
    .map((c) => ({ keys: c.from.split(/\s+/).map(key).filter(Boolean), to: c.to.trim() }))
    .filter((r) => r.keys.length > 0)
    .sort((a, b) => b.keys.length - a.keys.length);
}

/**
 * Each token as the dictionary says it must read. A correction may cover several tokens («cloud code» →
 * «Claude Code»): the first takes the new text and the others come back empty, so the list stays aligned
 * with the timings. Punctuation around the match is kept («claude,» → «Claude,»).
 */
export function correctTokens(tokens: string[], corrections: TranscriptCorrection[]): string[] {
  const list = rules(corrections);
  if (!list.length) return tokens;
  const keys = tokens.map(key);
  const out = [...tokens];
  for (let i = 0; i < tokens.length; i++) {
    if (!keys[i]) continue;
    const hit = list.find((r) => r.keys.every((k, j) => keys[i + j] === k));
    if (!hit) continue;
    const n = hit.keys.length;
    const lead = EDGES.exec(tokens[i])?.[1] ?? "", trail = EDGES.exec(tokens[i + n - 1])?.[2] ?? "";
    out[i] = hit.to ? `${lead}${hit.to}${trail}` : "";
    for (let j = 1; j < n; j++) out[i + j] = "";
    i += n - 1;
  }
  return out;
}

/** A subtitle's text with the dictionary applied, line by line; untouched when nothing matches. */
export function correctText(text: string, corrections: TranscriptCorrection[]): string {
  if (!corrections.length) return text;
  return text.split("\n").map((line) => {
    const tokens = line.trim().split(/\s+/).filter(Boolean);
    const fixed = correctTokens(tokens, corrections);
    return fixed.every((t, i) => t === tokens[i]) ? line : fixed.filter(Boolean).join(" ");
  }).join("\n");
}

export function transcriptState(doc: EditDocument): TranscriptState {
  return { corrections: doc.transcript?.corrections ?? [], proposals: doc.transcript?.proposals ?? [], ...(doc.transcript?.highlight ? { highlight: doc.transcript.highlight } : {}) };
}

/** The dictionary on every subtitle of the montage. Titles and other texts are left alone. */
export function correctCaptions(doc: EditDocument, corrections = transcriptState(doc).corrections): EditDocument {
  const overlays = doc.overlays.flatMap((o) => {
    if (o.kind !== "caption") return [o];
    const text = correctText(o.text, corrections);
    if (text === o.text) return [o];
    return text.trim() ? [{ ...o, text }] : [];
  });
  return { ...doc, overlays };
}

/** Adds or replaces corrections (by what is heard) and removes the listed ones; the subtitles follow. */
export function setCorrections(doc: EditDocument, add: TranscriptCorrection[], remove: string[] = []): EditDocument {
  const state = transcriptState(doc);
  const drop = new Set([...remove, ...add.map((c) => c.from)].map(fromKey));
  const corrections = [...state.corrections.filter((c) => !drop.has(fromKey(c.from))), ...add.map((c) => ({ from: c.from.trim(), to: c.to.trim() }))];
  // A corrected name is a keyword: the highlighting follows the new text.
  return highlightCaptions(correctCaptions({ ...doc, transcript: { ...state, corrections } }, corrections));
}

/** How many subtitles a dictionary would change. */
export function captionsCorrected(doc: EditDocument, corrections: TranscriptCorrection[]): number {
  return doc.overlays.filter((o) => o.kind === "caption" && correctText(o.text, corrections) !== o.text).length;
}

// ---------------------------------------------------------------- words in the montage

export interface PlacedWord {
  index: number;
  /** As the subtitles show it, after the dictionary; empty when merged into the previous word or hidden. */
  text: string;
  /** Seconds in the source file. */
  start: number;
  end: number;
  /** The clip that plays it, or null when it is out of the montage. */
  clipId: string | null;
  /** Timeline seconds where it is heard. */
  at: number | null;
  until: number | null;
}

/**
 * Where each word is heard. A word belongs to the clip it overlaps most, when that overlap is at least
 * min(0.15 s, half the word): short words («de», «lo») are not lost at a cut and none counts twice.
 */
export function placeWords(doc: EditDocument, assetId: string, words: WordTiming[], corrections = transcriptState(doc).corrections): PlacedWord[] {
  const clips = clipsOf(doc, assetId);
  const texts = correctTokens(words.map((w) => w.text), corrections);
  return words.map((w, index) => {
    let best: EditClip | null = null, bestOverlap = -1;
    const length = w.end - w.start;
    for (const c of clips) {
      const overlap = Math.min(w.end, clipEnd(c)) - Math.max(w.start, c.in);
      const inside = length < 0.02 ? w.start >= c.in - 0.001 && w.start <= clipEnd(c) + 0.001 : overlap > 0 && overlap >= Math.min(0.15, length / 2);
      if (inside && overlap > bestOverlap) { best = c; bestOverlap = overlap; }
    }
    if (!best) return { index, text: texts[index], start: w.start, end: w.end, clipId: null, at: null, until: null };
    const speed = clipSpeed(best), from = Math.max(w.start, best.in), to = Math.max(from, Math.min(w.end, clipEnd(best)));
    return { index, text: texts[index], start: w.start, end: w.end, clipId: best.id, at: round(best.start + (from - best.in) / speed), until: round(best.start + (to - best.in) / speed) };
  });
}

/** Share of a stretch of the file that is sound (not quiet), from its level. */
function loudShare(energy: AudioEnergy, from: number, to: number): number {
  const a = Math.floor(from / energy.step), b = Math.max(a + 1, Math.ceil(to / energy.step));
  let loud = 0;
  for (let k = a; k < b; k++) if ((energy.db[k] ?? -100) >= energy.quiet) loud++;
  return loud / (b - a);
}

/**
 * Word timings checked against the audio. When the recogniser cannot place some words it spreads them
 * evenly, often over the silence before them: a word whose whole span is quiet is not where it is said.
 * Each run of such words is moved, with the word after it, onto the sound that follows (by length of
 * word), so the transcript, the subtitles and the cuts agree with what is heard. Words over sound, and
 * words that run long over a silence (those keep their sound), are left as they are.
 */
export function retimeWords(words: WordTiming[], energy?: AudioEnergy): WordTiming[] {
  if (!energy?.db.length || !words.length) return words;
  const out = words.map((w) => ({ ...w }));
  const dead = (w: WordTiming) => loudShare(energy, w.start, Math.max(w.end, w.start + energy.step)) < 0.25;
  const length = (w: WordTiming) => w.end - w.start;
  for (let k = 0; k < out.length; k++) {
    if (!dead(out[k])) continue;
    let m = k;
    while (m + 1 < out.length && dead(out[m + 1])) m++;
    let n = m + 1;
    if (n >= out.length) break;
    // Words spread evenly (the same length, to the millisecond) were placed together: they move together.
    while (n + 1 < out.length && Math.abs(length(out[n + 1]) - length(out[k])) < 0.003 && Math.abs(length(out[n]) - length(out[k])) < 0.003) n++;
    // Where the sound starts again: past the tail of the word before (its decay often opens the run), then past the silence.
    const loud = (i: number) => (energy.db[i] ?? -100) >= energy.quiet;
    let f = Math.floor(out[k].start / energy.step);
    const tail = Math.min(Math.ceil(out[m].end / energy.step), f + Math.round(0.15 / energy.step));
    while (f < tail && loud(f)) f++;
    while (f < energy.db.length && !loud(f)) f++;
    const from = f * energy.step;
    // The recogniser squeezes the words after such a run too: take them in until each word has room to be said.
    while (out[n].end - from < 0.12 * (n - k + 1) && n + 1 < out.length && !dead(out[n + 1])) n++;
    const to = out[n].end;
    if (to - from < 0.06 * (n - k + 1)) { k = n; continue; }
    const weights = out.slice(k, n + 1).map((w) => Math.max(1, normalizeWord(w.text).length));
    const total = weights.reduce((sum, x) => sum + x, 0);
    let t = from;
    for (let q = k; q <= n; q++) {
      const length = (to - from) * weights[q - k] / total;
      out[q] = { ...out[q], start: round(t), end: round(t + length) };
      t += length;
    }
    k = n;
  }
  return out;
}

/** Timeline second where a second of the file is heard, or null when it is out of the montage. */
export function timelineAt(doc: EditDocument, assetId: string, t: number): number | null {
  const clip = clipsOf(doc, assetId).filter((c) => t >= c.in - 0.01 && t <= clipEnd(c) + 0.01).sort((a, b) => a.start - b.start)[0];
  return clip ? round(clip.start + (Math.max(t, clip.in) - clip.in) / clipSpeed(clip)) : null;
}

/** Source stretches of a file that the montage plays, merged. */
export function sourceCoverage(doc: EditDocument, assetId: string): SourceRange[] {
  return mergeRanges(clipsOf(doc, assetId).map((c) => ({ from: c.in, to: clipEnd(c) })));
}

// ---------------------------------------------------------------- cuts

/** The transcription's word edges are often a tenth or two off: the real gap is looked for this far around. */
const REACH = 0.25;
/** Quiet this close to the transcription's gap is the gap, however short. */
const NEAR = 0.08;
/**
 * Further away, only a pause this long counts: shorter quiet is more likely a consonant inside a word
 * (the closure of a «t», 30–80 ms) than the silence between two words.
 */
const PAUSE = 0.1;

/**
 * Where the sound really ends before a gap the transcription puts at [a, b] and where it starts again,
 * read from the level: the longest quiet run near the gap, grown while it stays quiet. A word the
 * recogniser stretched over a silence gives that silence back; one it clipped keeps its decay. `lo` and
 * `hi` bound the search; with no quiet there, or no level, the gap stays as the transcription gives it.
 */
export function soundGap(energy: AudioEnergy | undefined, a: number, b: number, lo: number, hi: number): [number, number] {
  if (!energy?.db.length) return [a, Math.max(a, b)];
  const { step, db, quiet } = energy;
  const frame = (t: number) => Math.max(0, Math.min(db.length - 1, Math.floor(t / step)));
  const silent = (k: number) => (db[k] ?? -100) < quiet;
  const floor = frame(lo), ceil = frame(hi);
  const near = [frame(Math.min(a, b) - NEAR), frame(Math.max(a, b) + NEAR)];
  const first = Math.max(floor, frame(Math.min(a, b) - REACH)), last = Math.min(ceil, frame(Math.max(a, b) + REACH));
  let best: [number, number] | null = null;
  for (let k = first; k <= last; k++) {
    if (!silent(k)) continue;
    let qa = k, qb = k;
    while (qa - 1 >= floor && silent(qa - 1)) qa--;
    while (qb + 1 <= ceil && silent(qb + 1)) qb++;
    const counts = (qb >= near[0] && qa <= near[1]) || (qb - qa + 1) * step >= PAUSE;
    if (counts && (!best || qb - qa > best[1] - best[0])) best = [qa, qb];
    k = qb;
  }
  if (!best) return [a, Math.max(a, b)];
  return [round(best[0] * step), round((best[1] + 1) * step)];
}

/** The quiet may run into the next word's span (the recogniser often starts it early), up to its real attack. */
const LATE_ATTACK = 0.6;

/**
 * Source stretch that takes out words i..j whole. The neighbours keep their attack and decay plus a
 * breath of `margin`, never more than half the gap, so a cut never eats into a word that stays. With the
 * level, the edges sit where the sound really stops and starts (see soundGap).
 */
export function wordCut(words: WordTiming[], i: number, j: number, margin = CUT_MARGIN, energy?: AudioEnergy): SourceRange {
  const prev = words[i - 1], next = words[j + 1];
  let from = 0, to = LONGEST;
  if (prev) {
    const [a, b] = soundGap(energy, prev.end, words[i].start, prev.start, Math.max(words[i].start, words[i].end - 0.02));
    from = a + Math.min(margin, (b - a) / 2);
  }
  if (next) {
    const [a, b] = soundGap(energy, words[j].end, next.start, Math.min(words[j].end, words[j].start + 0.02), next.end + LATE_ATTACK);
    to = b - Math.min(margin, (b - a) / 2);
  }
  return { from: round(from), to: round(Math.max(from, to)) };
}

/** What a proposal cuts: its words whole (see wordCut), or a pause less a breath on each side. */
export function proposalCut(words: WordTiming[], p: Pick<TranscriptProposal, "kind" | "from" | "to">, margin = CUT_MARGIN, energy?: AudioEnergy): SourceRange | null {
  if (p.kind !== "pause") {
    const inside = words.flatMap((w, k) => { const mid = (w.start + w.end) / 2; return mid >= p.from - 0.001 && mid <= p.to + 0.001 ? [k] : []; });
    if (inside.length) return wordCut(words, inside[0], inside.at(-1)!, margin, energy);
  }
  const before = words.findLast((w) => w.start < p.from - 0.001), after = words.find((w) => w.end > p.to + 0.001);
  const [a, b] = soundGap(energy, p.from, p.to, before ? before.start : 0, after ? after.end + LATE_ATTACK : LONGEST);
  const from = a + margin, to = b - margin;
  return to - from >= MIN_CUT ? { from: round(from), to: round(to) } : null;
}

/** Timeline stretches where a file plays the given source ranges. */
function timelineSpans(doc: EditDocument, assetId: string, ranges: SourceRange[]): Span[] {
  const spans: Span[] = [];
  for (const c of clipsOf(doc, assetId)) {
    const speed = clipSpeed(c);
    for (const r of ranges) {
      const a = Math.max(r.from, c.in), b = Math.min(r.to, clipEnd(c));
      if (b - a > 0.001) {
        const end = c.start + c.duration;
        // A snapped edge must never eat into a neighbouring clip of another source.
        spans.push({
          start: a === c.in ? c.start : Math.min(end, Math.max(c.start, frame(c.start + (a - c.in) / speed))),
          end: b === clipEnd(c) ? end : Math.min(end, Math.max(c.start, frame(c.start + (b - c.in) / speed))),
        });
      }
    }
  }
  return mergeSpans(spans);
}

/** Seconds of the montage the cuts would take out. */
export function cutSeconds(doc: EditDocument, assetId: string, ranges: SourceRange[]): number {
  return round(timelineSpans(doc, assetId, mergeRanges(ranges)).reduce((sum, s) => sum + s.end - s.start, 0));
}

/**
 * Takes timeline stretches out of every track and closes the gaps, as the silence autocut does: video,
 * voice, music and texts stay in sync. A clip cut in two keeps its id on the first piece; the pieces after
 * a cut are jump cuts, without the clip's entry transition.
 */
export function rippleRemove(doc: EditDocument, spans: Span[]): EditDocument {
  const cuts = mergeSpans(spans);
  if (!cuts.length) return doc;
  const kept: Span[] = [];
  let cursor = 0;
  for (const c of cuts) {
    if (c.start > cursor) kept.push({ start: cursor, end: c.start });
    cursor = Math.max(cursor, c.end);
  }
  kept.push({ start: cursor, end: LONGEST });
  const mapRaw = (t: number) => kept.reduce((sum, k) => sum + Math.max(0, Math.min(t, k.end) - k.start), 0);
  // Quantise cut edges, not every unrelated edit in the montage.
  const mapTime = (t: number) => Math.max(0, t - cuts.reduce((n, c) => n + Math.max(0, Math.min(t, c.end) - c.start), 0));
  const clips = doc.clips.flatMap((c) => {
    if (!cuts.some((s) => s.start < c.start + c.duration && s.end > c.start)) {
      const start = mapTime(c.start);
      return [start === c.start ? c : { ...c, start }];
    }
    let first = true;
    return kept.flatMap((r) => {
      const from = Math.max(c.start, r.start), to = Math.min(c.start + c.duration, r.end);
      if (to - from < 0.04) return [];
      const start = mapTime(from), finish = mapTime(to);
      if (finish - start < 0.04) return [];
      const piece: EditClip = { ...c, id: first ? c.id : crypto.randomUUID(), start, duration: finish - start, in: c.in + (from - c.start) * clipSpeed(c), transition: from > c.start + 0.001 ? "cut" : c.transition };
      first = false;
      return [piece];
    });
  });
  const overlays = doc.overlays.flatMap((o) => {
    const start = mapTime(o.start);
    const overlap = cuts.reduce((n, c) => n + Math.max(0, Math.min(o.start + o.duration, c.end) - Math.max(o.start, c.start)), 0);
    if (!overlap) return [start === o.start ? o : { ...o, start }];
    const duration = o.duration - overlap;
    return duration >= 0.04 ? [{ ...o, start, duration }] : [];
  });
  return { ...doc, enabled: true, duration: Math.max(0.1, round(mapRaw(doc.duration))), clips, overlays };
}

/**
 * Opens `length` seconds at timeline second `at` on every track. Clips after it move later; a clip that
 * plays across it is split and its second half waits, preserving its original source position. A still
 * image without motion and texts across it can simply stay on screen longer.
 */
function rippleInsert(doc: EditDocument, at: number, length: number, except: Set<string>): EditDocument {
  const clips = doc.clips.flatMap((c): EditClip[] => {
    if (except.has(c.id)) return [c];
    if (c.start >= at - 0.001) return [{ ...c, start: c.start + length }];
    if (c.start + c.duration <= at + 0.001) return [c];
    const asset = doc.assets.find((a) => a.id === c.assetId);
    if (asset?.kind === "image" && c.motion === "none") return [{ ...c, duration: c.duration + length }];
    const head = at - c.start;
    return [{ ...c, duration: head }, { ...c, id: crypto.randomUUID(), start: at + length, in: c.in + head * clipSpeed(c), duration: c.duration - head, transition: "cut" }];
  });
  const overlays = doc.overlays.map((o) => o.start >= at - 0.001 ? { ...o, start: o.start + length } : o.start + o.duration > at + 0.001 ? { ...o, duration: o.duration + length } : o);
  return { ...doc, enabled: true, duration: round(doc.duration + (doc.duration >= at - 0.001 ? length : 0)), clips, overlays };
}

/** Puts a stretch of a file back into the montage, next to the piece it was cut from. */
export function restoreSource(doc: EditDocument, assetId: string, range: SourceRange): EditDocument {
  const asset = doc.assets.find((a) => a.id === assetId);
  if (!asset) return doc;
  const from = Math.max(0, range.from), to = Math.min(asset.duration, range.to);
  if (to - from < 0.04) return doc;
  const clips = clipsOf(doc, assetId).sort((a, b) => a.start - b.start);
  const before = clips.find((c) => Math.abs(clipEnd(c) - from) < 0.01);
  const after = clips.find((c) => Math.abs(c.in - to) < 0.01);
  if (before) {
    const length = (to - from) / clipSpeed(before), at = before.start + before.duration;
    let next = rippleInsert(doc, at, length, new Set([before.id]));
    const grown = { ...before, duration: before.duration + length };
    // The piece that continued it rejoins it: the shot is whole again.
    const follower = after ? next.clips.find((c) => c.id === after.id) : undefined;
    const rejoined = follower && Math.abs(follower.start - (grown.start + grown.duration)) < 0.02 && (follower.track ?? 0) === (grown.track ?? 0)
      && clipSpeed(follower) === clipSpeed(grown) && follower.volume === grown.volume && follower.fit === grown.fit
      && follower.transition === "cut" && follower.motion === "none" && grown.motion === "none" ? follower.id : null;
    if (rejoined && follower) grown.duration += follower.duration;
    // Frame rounding of the earlier cut must not leave the shot asking for more than the file has.
    if (asset.kind !== "image") grown.duration = Math.min(grown.duration, (asset.duration - grown.in) / clipSpeed(grown));
    next = { ...next, clips: next.clips.flatMap((c) => c.id === before.id ? [grown] : c.id === rejoined ? [] : [c]) };
    return next;
  }
  if (after) {
    const length = (to - from) / clipSpeed(after);
    const next = rippleInsert(doc, after.start, length, new Set([after.id]));
    return { ...next, clips: next.clips.map((c) => c.id === after.id ? { ...c, in: round(from), duration: c.duration + length } : c) };
  }
  // No piece touches it: a new piece, placed where the file's order puts it.
  const prior = clips.filter((c) => clipEnd(c) <= from + 0.01).sort((a, b) => clipEnd(b) - clipEnd(a))[0];
  const template = prior ?? clips[0];
  if (!template) return doc;
  const at = prior ? prior.start + prior.duration : template.start;
  const length = (to - from) / clipSpeed(template);
  const next = rippleInsert(doc, at, length, new Set());
  return { ...next, clips: [...next.clips, { ...template, id: crypto.randomUUID(), start: round(at), in: round(from), duration: length, transition: "cut" }] };
}

/**
 * The stretch to put back for missing words i..j: up to the pieces that are still in when the neighbours
 * are in (the shot rejoins as it was), or just the words and a breath when their neighbours are out too.
 */
function restoreRange(words: WordTiming[], i: number, j: number, coverage: SourceRange[], assetDuration: number, margin: number, energy?: AudioEnergy): SourceRange {
  const priorEnds = coverage.filter((r) => r.to <= words[i].end + 0.001).map((r) => r.to);
  const laterStarts = coverage.filter((r) => r.from >= words[j].start - 0.001).map((r) => r.from);
  const holeStart = priorEnds.length ? Math.max(...priorEnds) : Math.max(0, words[i].start - margin);
  const holeEnd = laterStarts.length ? Math.min(...laterStarts) : Math.min(assetDuration, words[j].end + margin);
  const prev = words[i - 1], next = words[j + 1];
  let from = holeStart, to = holeEnd;
  if (prev && prev.end > holeStart + 0.001) {
    const [a, b] = soundGap(energy, prev.end, words[i].start, prev.start, Math.max(words[i].start, words[i].end - 0.02));
    from = Math.max(holeStart, b - Math.min(margin, (b - a) / 2));
  }
  if (next && next.start < holeEnd - 0.001) {
    const [a, b] = soundGap(energy, words[j].end, next.start, Math.min(words[j].end, words[j].start + 0.02), next.end + LATE_ATTACK);
    to = Math.min(holeEnd, a + Math.min(margin, (b - a) / 2));
  }
  return { from: round(from), to: round(Math.max(from, to)) };
}

// ---------------------------------------------------------------- subtitles from words

/** Words that lean on the next one: a subtitle does not end on them («de», «la», «y»…). */
const LEANING = new Set(["a", "al", "con", "de", "del", "desde", "hasta", "hacia", "entre", "sobre", "tras", "segun", "el", "en", "la", "las", "lo", "los", "mi", "mis", "para", "por", "que", "se", "su", "sus", "tu", "tus", "un", "una", "unos", "unas", "y", "o", "e", "ni", "u", "pero", "como", "sin", "me", "te", "nos", "os", "le", "les", "muy", "mas", "the", "of", "to", "and", "an"]);
const SENTENCE = /[.!?…]["»”)]?$/;
const CLAUSE = /[,;:]["»”)]?$/;

/**
 * Subtitles that read as phrases: a new one at the end of a sentence, at a comma once it holds two words,
 * at a pause, or when it would pass `perCue` words or `maxChars` letters (one line on a phone). Short
 * words that lean on the next («de», «la», «y») do not count as words, and a line never ends on them:
 * they open the next subtitle with the word they introduce. The voice-over's subtitles follow the same rule.
 */
export function groupCaptionWords(items: { text: string; start: number; end: number }[], perCue = 4, maxChars = 32): { text: string; start: number; end: number }[] {
  const cues: { text: string; start: number; end: number }[] = [];
  let group: typeof items = [];
  const length = (g: typeof items) => g.reduce((n, w) => n + w.text.length, 0) + Math.max(0, g.length - 1);
  const leans = (w: { text: string }) => LEANING.has(normalizeWord(w.text)) && !CLAUSE.test(w.text) && !SENTENCE.test(w.text);
  const counted = (g: typeof items) => g.filter((w) => !leans(w)).length;
  const close = (g: typeof items) => { if (g.length) cues.push({ text: g.map((w) => w.text).join(" "), start: g[0].start, end: g.at(-1)!.end }); };
  for (const [i, word] of items.entries()) {
    const gap = i > 0 ? word.start - items[i - 1].end : 0;
    if (group.length && (gap > 0.35 || counted([...group, word]) > perCue || length([...group, word]) > maxChars)) {
      const carry: typeof items = [];
      if (gap <= 0.35) {
        while (group.length > 1 && leans(group.at(-1)!)) carry.unshift(group.pop()!);
      }
      close(group);
      group = carry;
    }
    group.push(word);
    if (SENTENCE.test(word.text) || (CLAUSE.test(word.text) && group.length >= 2)) { close(group); group = []; }
  }
  close(group);
  return cues;
}

/** Words per subtitle: what the style reference's analysis says, else four (as the voice-over's). */
export function captionWordsPerCue(doc: Pick<EditDocument, "references">): number {
  return doc.references.find((r) => r.roles.includes("style") && r.analysis)?.analysis?.text.wordsPerCue ?? 4;
}

/** How new subtitles look: like the subtitle they replace, else as the style reference shows them. */
function captionLook(doc: Pick<EditDocument, "references">, style?: EditOverlay): Partial<EditOverlay> {
  if (style) return { ...captionAppearanceSchema.parse(style), ...(style.track !== undefined ? { track: style.track } : {}) };
  return doc.references.find((r) => r.roles.includes("style") && r.analysis)?.analysis?.text.appearance ?? {};
}

function cueOverlays(cues: { text: string; start: number; end: number }[], look: Partial<EditOverlay> = {}): EditOverlay[] {
  return cues.map((cue, k) => {
    const next = cues[k + 1];
    const end = Math.max(cue.end, cue.start + 0.3);
    const duration = Math.max(MIN_CAPTION, (next ? Math.min(end, next.start) : end) - cue.start);
    return { ...newOverlay(cue.text, round(cue.start), round(duration), "caption"), ...look };
  });
}

/** Subtitles in source seconds (what a transcription returns), from the words and the dictionary. */
export function sourceCaptions(words: WordTiming[], corrections: TranscriptCorrection[] = [], perCue = 4, look: Partial<EditOverlay> = {}): EditOverlay[] {
  const texts = correctTokens(words.map((w) => w.text), corrections);
  return cueOverlays(groupCaptionWords(words.flatMap((w, k) => texts[k] ? [{ text: texts[k], start: w.start, end: Math.max(w.end, w.start) }] : []), perCue), look);
}

/** The subtitles of one file as the montage plays it: only the words that are in, at their timeline seconds. */
export function montageCaptions(doc: EditDocument, assetId: string, words: WordTiming[], style?: EditOverlay, perCue = captionWordsPerCue(doc)): EditOverlay[] {
  const placed = placeWords(doc, assetId, words).filter((w) => w.at !== null && w.text).sort((a, b) => a.at! - b.at!);
  const state = transcriptState(doc);
  return cueOverlays(groupCaptionWords(placed.map((w) => ({ text: w.text, start: w.at!, end: Math.max(w.at!, w.until!) })), perCue), captionLook(doc, style)).map((o) => highlightOverlay({ ...o,
    transcriptSource: { assetId, words: placed.filter((w) => w.at! >= o.start - 0.001 && w.at! < o.start + o.duration - 0.001).map((w) => w.index) },
  }, state));
}

// ---------------------------------------------------------------- keywords

/** Words that never are the keyword of a subtitle, however long. */
const PLAIN = new Set([...LEANING, "este", "esta", "esto", "estos", "estas", "eso", "esa", "ese", "aqui", "ahi", "porque", "cuando", "donde", "entonces", "tambien", "ahora", "todo", "todos", "toda", "todas", "hacer", "tener", "puede", "pueden", "vamos", "quiero", "tengo", "tiene", "tienes", "hemos", "habia", "sobre", "desde", "hasta", "entre", "otra", "otro", "cada", "mucho", "mucha", "muchos", "muchas", "bueno", "pues", "vale", "solo", "algo", "nada", "cosa", "cosas", "gente", "verdad", "realmente", "basicamente", "simplemente", "siempre", "despues", "antes", "mientras", "nuestro", "nuestra", "vuestro", "vuestra", "cualquier"]);
const core = (token: string) => token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
/** A line written all in capitals (Mi estilo «en MAYÚSCULAS»). */
const allCaps = (text: string) => text === text.toLocaleUpperCase("es") && /\p{Lu}/u.test(text);

/**
 * The keyword of a subtitle, at most one: a number, a name from the dictionary, a capitalised name in
 * mid-line, or else its strongest word (seven letters or more, not a filler) when it has three words.
 * `chosen` (the assistant's list) replaces that guess: every word of the list in the line is marked.
 */
export function captionKeywords(text: string, names: string[] = [], chosen?: string[]): string[] {
  const tokens = text.split(/\s+/).filter(Boolean);
  const keys = tokens.map(key);
  if (chosen) {
    const wanted = new Set(chosen.flatMap((w) => w.split(/\s+/)).map(key).filter(Boolean));
    return [...new Set(tokens.filter((_, i) => wanted.has(keys[i])).map(core))];
  }
  const named = new Set(names.flatMap((n) => n.split(/\s+/)).map(key).filter(Boolean));
  let pick = tokens.findIndex((t, i) => keys[i] && /\d/.test(t));
  if (pick < 0) pick = keys.findIndex((k) => named.has(k));
  if (pick >= 0 && named.has(keys[pick])) {
    // A name of several words («Claude Code») is marked whole.
    const words: string[] = [];
    for (let i = pick; i < tokens.length && named.has(keys[i]); i++) words.push(core(tokens[i]));
    return words;
  }
  // In a line all in capitals every word looks like a name.
  if (pick < 0 && !allCaps(text)) pick = tokens.findIndex((t, i) => i > 0 && keys[i].length > 1 && /^\p{Lu}/u.test(core(t)));
  if (pick < 0 && tokens.length >= 3) {
    let best = -1;
    tokens.forEach((t, i) => { const n = normalizeWord(t); if (n.length >= 7 && !PLAIN.has(n) && (best < 0 || n.length > normalizeWord(tokens[best]).length)) best = i; });
    pick = best;
  }
  return pick < 0 ? [] : [core(tokens[pick])];
}

/** One subtitle with the project's keyword colour applied (or taken off when highlighting is off). */
function highlightOverlay(o: EditOverlay, state: TranscriptState): EditOverlay {
  if (o.kind !== "caption") return o;
  const { emphasis: _e, accent: _a, ...plain } = o;
  if (!state.highlight) return o.emphasis || o.accent ? plain : o;
  const marks = captionKeywords(o.text, state.corrections.map((c) => c.to).filter(Boolean), state.highlight.words);
  return marks.length ? { ...plain, emphasis: marks, accent: state.highlight.color } : plain;
}

/** Every subtitle with its keywords in the project's colour, or none when highlighting is off. */
export function highlightCaptions(doc: EditDocument): EditDocument {
  const state = transcriptState(doc);
  return { ...doc, overlays: doc.overlays.map((o) => highlightOverlay(o, state)) };
}

/** Turns keyword highlighting on (in `color`, with the assistant's `words` or found automatically) or off. */
export function setHighlight(doc: EditDocument, highlight: { color: string; words?: string[] } | null): EditDocument {
  const { highlight: _old, ...state } = transcriptState(doc);
  return highlightCaptions({ ...doc, transcript: highlight ? { ...state, highlight } : state });
}

/** A file's subtitles: the caption overlays over its clips. */
export function captionsOver(doc: EditDocument, assetId: string): EditOverlay[] {
  const clips = clipsOf(doc, assetId);
  return doc.overlays.filter((o) => o.kind === "caption" && (o.transcriptSource ? o.transcriptSource.assetId === assetId : clips.some((c) => o.start < c.start + c.duration && o.start + o.duration > c.start)));
}

/** Words belonging to a cue, with a conservative fallback for montages saved before ownership existed. */
export function captionWordTimings(doc: EditDocument, assetId: string, words: WordTiming[], cue: EditOverlay, timings = placeWords(doc, assetId, words)): PlacedWord[] {
  if (cue.kind !== "caption" || (cue.transcriptSource && cue.transcriptSource.assetId !== assetId)) return [];
  const placed = timings.filter((w) => w.at !== null && w.text).sort((a, b) => a.at! - b.at!);
  if (cue.transcriptSource) {
    const indices = new Set(cue.transcriptSource.words);
    return placed.filter((w) => indices.has(w.index));
  }
  const spoken = placed.filter((w) => {
    const mid = (w.at! + w.until!) / 2;
    return mid >= cue.start - 0.001 && mid < cue.start + cue.duration;
  });
  const overlapping = doc.clips.filter((c) => c.start < cue.start + cue.duration && c.start + c.duration > cue.start && doc.assets.find((a) => a.id === c.assetId)?.hasAudio);
  if (overlapping.some((c) => c.assetId !== assetId)) {
    // A music bed must not prevent legacy subtitles from following their speaker. With competing
    // sources, require textual evidence instead of assigning every overlapping caption to this file.
    const said = new Set(spoken.flatMap((w) => w.text.split(/\s+/).map(key)));
    const tokens = cue.text.split(/\s+/).map(key).filter(Boolean);
    if (!tokens.length || tokens.filter((t) => said.has(t)).length < Math.ceil(tokens.length / 2)) return [];
  }
  return spoken;
}

/** Align edited caption tokens to spoken words. Substitutions retain the user's spelling and punctuation. */
function alignedCaptionTokens(cue: EditOverlay, spoken: PlacedWord[]): { text: string; index: number }[] {
  const tokens = cue.text.match(/\s*\S+/g) ?? [];
  const source = spoken.flatMap((w) => w.text.split(/\s+/).filter(Boolean).map((text) => ({ text, index: w.index })));
  if (!tokens.length || !source.length) return [];
  const cost = Array.from({ length: source.length + 1 }, () => new Uint16Array(tokens.length + 1));
  for (let i = 0; i <= source.length; i++) cost[i][0] = i;
  for (let j = 0; j <= tokens.length; j++) cost[0][j] = j;
  for (let i = 1; i <= source.length; i++) for (let j = 1; j <= tokens.length; j++) {
    cost[i][j] = Math.min(cost[i - 1][j] + 1, cost[i][j - 1] + 1, cost[i - 1][j - 1] + (key(source[i - 1].text) === key(tokens[j - 1]) ? 0 : 1));
  }
  const indices = new Array<number>(tokens.length);
  let i = source.length, j = tokens.length;
  while (j > 0 || i > 0) {
    if (i > 0 && j > 0 && cost[i][j] === cost[i - 1][j - 1] + (key(source[i - 1].text) === key(tokens[j - 1]) ? 0 : 1)) {
      indices[--j] = source[--i].index;
    } else if (j > 0 && cost[i][j] === cost[i][j - 1] + 1) {
      indices[--j] = source[Math.min(i, source.length - 1)].index;
    } else i--;
  }
  return tokens.map((text, k) => ({ text, index: indices[k] }));
}

/** A style may regroup text, but must never invent speech timing from character counts. */
export function splitCaptionByWords(cue: EditOverlay, spoken: PlacedWord[], perCue: number): EditOverlay[] {
  const tokens = alignedCaptionTokens(cue, spoken);
  if (!tokens.length || tokens.length <= perCue) return [cue];
  const said = new Set(spoken.flatMap((w) => w.text.split(/\s+/).map(key)));
  if (tokens.filter((t) => said.has(key(t.text))).length < Math.ceil(tokens.length / 2)) return [cue];
  const groups = [];
  for (let k = 0; k < tokens.length; k += perCue) groups.push(tokens.slice(k, k + perCue));
  const at = new Map(spoken.map((w) => [w.index, w.at!]));
  const starts = groups.map((g, k) => k === 0 ? cue.start : Math.max(cue.start, at.get(g[0].index) ?? cue.start));
  const ends = groups.map((_, k) => starts[k + 1] ?? cue.start + cue.duration);
  if (groups.some((_, k) => ends[k] - starts[k] < MIN_CAPTION)) return [cue];
  return groups.map((g, k) => ({ ...cue, id: k === 0 ? cue.id : crypto.randomUUID(), text: g.map((t) => t.text).join("").trim(), start: starts[k], duration: ends[k] - starts[k],
    ...(cue.transcriptSource ? { transcriptSource: { assetId: cue.transcriptSource.assetId, words: [...new Set(g.map((t) => t.index))] } } : {}),
  }));
}

/** Only cues that actually lose words change text. All other IDs, edits and grouping survive the ripple. */
export function refreshCaptions(before: EditDocument, after: EditDocument, assetId: string, words: WordTiming[]): EditDocument {
  const previous = new Map(before.overlays.map((o) => [o.id, o]));
  const placed = placeWords(after, assetId, words).filter((w) => w.clipId !== null).sort((a, b) => a.at! - b.at!);
  const surviving = new Set(placed.map((w) => w.index));
  const beforePlaced = placeWords(before, assetId, words);
  const wasIn = new Set(beforePlaced.filter((w) => w.clipId !== null).map((w) => w.index));
  const added = placed.filter((w) => !wasIn.has(w.index) && w.text);
  const claimed = new Set<number>();
  // A subtitle whose words changed gets its keyword again, and restored words follow its capitals.
  const state = transcriptState(after);
  const like = (text: string, look: EditOverlay) => allCaps(look.text) ? text.toLocaleUpperCase("es") : text;
  const overlays = after.overlays.flatMap((cue) => {
    const old = previous.get(cue.id);
    if (!old || old.kind !== "caption") return [cue];
    const spoken = captionWordTimings(before, assetId, words, old, beforePlaced);
    if (!spoken.length) return [cue];
    const inserted = added.filter((w) => !claimed.has(w.index) && w.at! >= cue.start && w.at! < cue.start + cue.duration);
    if (!inserted.length && spoken.every((w) => surviving.has(w.index))) return [cue];
    inserted.forEach((w) => claimed.add(w.index));
    const times = new Map(placed.map((w) => [w.index, w.at!]));
    const tokens = [...alignedCaptionTokens(old, spoken).filter((t) => surviving.has(t.index)), ...inserted.map((w) => ({ text: ` ${like(w.text, old)}`, index: w.index }))];
    if (inserted.length) tokens.sort((a, b) => times.get(a.index)! - times.get(b.index)!);
    const text = (inserted.length ? tokens.map((t) => t.text.trim()).join(" ") : tokens.map((t) => t.text).join("")).trim();
    if (!text) return [];
    return [highlightOverlay({ ...cue, text, transcriptSource: { assetId, words: [...new Set(tokens.map((t) => t.index))] } }, state)];
  });
  // Restoring words only creates subtitles for the restored material; it never regroups the rest.
  const old = captionsOver(before, assetId);
  if (old.length) {
    const remaining = added.filter((w) => !claimed.has(w.index));
    const cues = groupCaptionWords(remaining.map((w) => ({ text: w.text, start: w.at!, end: w.until! })), captionWordsPerCue(after));
    for (const cue of cueOverlays(cues)) {
      const nearest = [...old].sort((a, b) => Math.abs(a.start - cue.start) - Math.abs(b.start - cue.start))[0];
      const end = Math.min(cue.start + cue.duration, ...overlays.filter((o) => o.kind === "caption" && o.start > cue.start).map((o) => o.start));
      if (end - cue.start < MIN_CAPTION) continue;
      overlays.push(highlightOverlay({ ...nearest, id: cue.id, text: like(cue.text, nearest), start: cue.start, duration: end - cue.start,
        transcriptSource: { assetId, words: remaining.filter((w) => w.at! >= cue.start - 0.001 && w.at! < end).map((w) => w.index) },
      }, state));
    }
  }
  return { ...after, overlays };
}

// ---------------------------------------------------------------- editing by words

/** Proposals still worth showing: not settled, and still about material that is in the montage. */
function pruneProposals(doc: EditDocument, assetId: string, settled: Set<string>): EditDocument {
  const state = transcriptState(doc);
  if (!state.proposals.length) return doc;
  const coverage = sourceCoverage(doc, assetId);
  const proposals = state.proposals.filter((p) => !settled.has(p.id) && (p.assetId !== assetId || coverage.some((r) => Math.min(r.to, p.to) - Math.max(r.from, p.from) > 0.05)));
  return proposals.length === state.proposals.length ? doc : { ...doc, transcript: { ...state, proposals } };
}

/** `removed`: seconds the montage lost (negative when restoring words gave it back). */
export interface CutResult { doc: EditDocument; removed: number }

/** Cuts source ranges of a file out of the montage, rebuilds its subtitles and drops the proposals it settles. */
export function applyCuts(doc: EditDocument, assetId: string, words: WordTiming[], ranges: SourceRange[], settled: string[] = []): CutResult {
  const spans = timelineSpans(doc, assetId, mergeRanges(ranges));
  const removed = round(spans.reduce((sum, s) => sum + s.end - s.start, 0));
  const cut = removed > 0 ? refreshCaptions(doc, rippleRemove(doc, spans), assetId, words) : doc;
  return { doc: pruneProposals(cut, assetId, new Set(settled)), removed };
}

/** Takes words i..j out of the montage, whole, with a breath of `margin` next to the words that stay. */
export function removeWords(doc: EditDocument, assetId: string, words: WordTiming[], i: number, j: number, margin = CUT_MARGIN, energy?: AudioEnergy): CutResult {
  const [a, b] = [Math.max(0, Math.min(i, j)), Math.min(words.length - 1, Math.max(i, j))];
  return applyCuts(doc, assetId, words, [wordCut(words, a, b, margin, energy)]);
}

/** Puts back the words of i..j that are out of the montage, each run next to where it was cut. */
export function restoreWords(doc: EditDocument, assetId: string, words: WordTiming[], i: number, j: number, margin = CUT_MARGIN, energy?: AudioEnergy): CutResult {
  const asset = doc.assets.find((x) => x.id === assetId);
  if (!asset) return { doc, removed: 0 };
  const [a, b] = [Math.max(0, Math.min(i, j)), Math.min(words.length - 1, Math.max(i, j))];
  const before = editLength(doc);
  let next = doc;
  // Run by run, last first: each restore reads the montage as the previous one left it.
  const missing = placeWords(doc, assetId, words).slice(a, b + 1).filter((w) => w.clipId === null).map((w) => w.index);
  const runs: [number, number][] = [];
  for (const k of missing) {
    const last = runs.at(-1);
    if (last && k === last[1] + 1) last[1] = k;
    else runs.push([k, k]);
  }
  for (const [from, to] of runs.reverse()) next = restoreSource(next, assetId, restoreRange(words, from, to, sourceCoverage(next, assetId), asset.duration, margin, energy));
  next = refreshCaptions(doc, next, assetId, words);
  return { doc: next, removed: round(before - editLength(next)) };
}

const editLength = (d: EditDocument) => Math.max(d.duration, ...[...d.clips, ...d.overlays].map((x) => x.start + x.duration));

// ---------------------------------------------------------------- proposals

export function proposalsFor(doc: EditDocument, assetId: string): TranscriptProposal[] {
  return transcriptState(doc).proposals.filter((p) => p.assetId === assetId);
}

/** Replaces a file's proposals (or adds to them) for the user to review. */
export function saveProposals(doc: EditDocument, assetId: string, proposals: TranscriptProposal[], replace = true): EditDocument {
  const state = transcriptState(doc);
  const kept = state.proposals.filter((p) => p.assetId !== assetId || !replace);
  return { ...doc, transcript: { ...state, proposals: [...kept, ...proposals].slice(-400) } };
}

/** Drops proposals the user turned down. */
export function dismissProposals(doc: EditDocument, ids: string[]): EditDocument {
  const state = transcriptState(doc), drop = new Set(ids);
  return { ...doc, transcript: { ...state, proposals: state.proposals.filter((p) => !drop.has(p.id)) } };
}

/** Hesitations that never carry meaning. */
const HESITATIONS = new Set(["eh", "ehh", "ehhh", "ehm", "em", "emm", "mm", "mmm", "hmm", "mmh", "uh", "uhm", "um", "ah", "aah"]);
/** Pet phrases that may carry meaning: proposed only when they stand apart, and unticked. */
const PET_PHRASES = [["o", "sea"], ["en", "plan"], ["como", "que"], ["a", "ver"], ["digamos"], ["tipo"], ["bueno"], ["pues"], ["vale"], ["este"], ["esto"], ["i", "mean"], ["you", "know"], ["like"], ["well"], ["okay"]];
/** Tags at the end of a sentence: «¿vale?», «¿sabes?», «¿no?». */
const TAGS = new Set(["vale", "sabes", "no", "verdad", "entiendes", "ves", "right", "okay"]);
/** Words people double on purpose («muy muy», «no no»): not a stumble. */
const EMPHASIS = new Set(["muy", "no", "si", "mas", "ya", "venga", "vale", "bien", "mucho", "poco", "ja", "je", "jaja", "ay", "nada", "hola", "gracias", "vamos", "corre", "otra", "very", "so", "yes", "really", "go", "run"]);

const seconds = (n: number) => `${n.toLocaleString(getLocale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 })} s`;
const quote = (items: { text: string }[]) => items.map((w) => w.text).filter(Boolean).join(" ");

export interface CleanupOptions {
  /** Pauses at least this long are proposed (s). */
  minPause?: number;
  /** Quiet stretches measured on the audio: they catch pauses the transcription stretched a word over. */
  silences?: SourceRange[];
  /** The audio level, to place each cut where the sound stops and starts. */
  energy?: AudioEnergy;
}

/**
 * What a first cleaning pass would take out of a file's speech, for the user to review: long pauses,
 * takes said twice (the last one stays) and hesitations or pet phrases. Only material that is in the
 * montage counts. Phrases that do not add anything need judgement: the assistant proposes those.
 */
export function suggestCleanup(doc: EditDocument, assetId: string, words: WordTiming[], options: CleanupOptions = {}): TranscriptProposal[] {
  if (!words.length) return [];
  const minPause = options.minPause ?? DEFAULT_PAUSE;
  const asset = doc.assets.find((a) => a.id === assetId);
  const total = asset?.duration ?? words.at(-1)!.end;
  const placed = placeWords(doc, assetId, words);
  const coverage = sourceCoverage(doc, assetId);
  const covered = (r: SourceRange) => coverage.reduce((sum, c) => sum + Math.max(0, Math.min(c.to, r.to) - Math.max(c.from, r.from)), 0);
  const texts = placed.map((w) => w.text);
  const out: TranscriptProposal[] = [];

  // Long pauses: gaps between words, joined with the quiet the audio shows. A short, well-timed word inside
  // a quiet stretch is protected; a long one is the recogniser stretching a word over the silence.
  const gaps: SourceRange[] = [{ from: 0, to: words[0].start }, ...words.slice(1).map((w, k) => ({ from: words[k].end, to: w.start })), { from: words.at(-1)!.end, to: total }];
  const protectedWords = words.filter((w) => w.end - w.start <= 0.8);
  const quiet = (options.silences ?? []).flatMap((s) => {
    let pieces: SourceRange[] = [s];
    for (const w of protectedWords) pieces = pieces.flatMap((p) => w.end <= p.from || w.start >= p.to ? [p] : [{ from: p.from, to: w.start }, { from: w.end, to: p.to }]);
    return pieces;
  });
  for (const pause of mergeRanges([...gaps, ...quiet].filter((g) => g.to - g.from >= minPause))) {
    const cut = proposalCut(words, { kind: "pause", ...pause }, CUT_MARGIN, options.energy);
    if (!cut || covered(cut) < MIN_CUT) continue;
    // The word the pause follows: the last one to start before it (a word stretched over the pause included).
    const before = words.findLastIndex((w) => w.start < pause.from - 0.01);
    const where = pause.from < 0.05 ? "al empezar" : before >= 0 ? translate("after \"{0} '", texts[before] || words[before].text) : "";
    out.push({ id: `auto-pause-${Math.round(pause.from * 1000)}`, assetId, kind: "pause", from: round(pause.from), to: round(pause.to), text: "", reason: translate("{0} {1}", seconds(pause.to - pause.from), where).trim(), preselect: true });
  }

  // Takes said again: the same words back to back, possibly with a broken word or two in between. The
  // last take is usually the good one (the speaker restarted to fix the one before), so it stays; a phrase
  // said three times gives two proposals. Only the takes that go are marked, so the next can be compared.
  const keys = words.map((w) => normalizeWord(w.text));
  const used = new Set<number>();
  const inMontage = (from: number, to: number) => placed.slice(from, to + 1).every((w) => w.clipId !== null);
  const takes: { i: number; k: number; n: number }[] = [];
  for (let n = 8; n >= 1; n--) {
    for (let i = 0; i + 2 * n <= words.length; i++) {
      for (const stray of n >= 3 ? [0, 1, 2] : [0]) {
        const k = i + n + stray;
        if (k + n > words.length || used.has(i)) continue;
        let same = true;
        for (let q = 0; q < n && same; q++) same = !!keys[i + q] && keys[i + q] === keys[k + q];
        if (!same || (n === 1 && EMPHASIS.has(keys[i])) || words[k].start - words[i].start > 20) continue;
        if ([...Array(k + n - i).keys()].some((q) => used.has(i + q)) || !inMontage(i, k + n - 1)) continue;
        for (let q = i; q < k; q++) used.add(q);
        takes.push({ i, k, n });
        break;
      }
    }
  }
  for (const { i, k, n } of takes) {
    let last = k;
    for (let next = takes.find((t) => t.i === last); next; next = takes.find((t) => t.i === last)) last = next.k;
    const gone = placed.slice(i, k), kept = placed.slice(last, Math.min(words.length, last + n + 3));
    out.push({ id: `auto-retake-${i}`, assetId, kind: "retake", from: round(words[i].start), to: round(words[k - 1].end), text: quote(gone),
      reason: n === 1 ? translate("\"{0}\" is repeated: it stays the last time.", quote(gone)) : translate("Repeated take: the last one remains, \"{0}...\"", quote(kept)), preselect: true });
  }

  // Hesitations and pet phrases.
  const ends = (t: string) => /[.,;:!?…]["»”)]?$/.test(t);
  for (let k = 0; k < words.length; k++) {
    if (used.has(k) || placed[k].clipId === null || !keys[k]) continue;
    if (HESITATIONS.has(keys[k])) {
      out.push({ id: `auto-filler-${k}`, assetId, kind: "filler", from: round(words[k].start), to: round(words[k].end), text: texts[k] || words[k].text, reason: "Duda («eh», «mmm»): no aporta nada.", preselect: true });
      continue;
    }
    if (TAGS.has(keys[k]) && /\?/.test(words[k].text) && k > 0) {
      out.push({ id: `auto-filler-${k}`, assetId, kind: "filler", from: round(words[k].start), to: round(words[k].end), text: texts[k] || words[k].text, reason: translate("Coletilla at the end of the sentence. Check if it is enough."), preselect: false });
      continue;
    }
    const pet = PET_PHRASES.find((p) => p.every((x, q) => keys[k + q] === x));
    if (!pet) continue;
    const last = k + pet.length - 1;
    const apartBefore = k === 0 || ends(words[k - 1].text) || words[k].start - words[k - 1].end >= 0.3;
    const apartAfter = ends(words[last].text) || !words[last + 1] || words[last + 1].start - words[last].end >= 0.25;
    if (!apartBefore || !apartAfter || !inMontage(k, last)) continue;
    for (let q = k; q <= last; q++) used.add(q);
    out.push({ id: `auto-filler-${k}`, assetId, kind: "filler", from: round(words[k].start), to: round(words[last].end), text: quote(placed.slice(k, last + 1)), reason: translate("A loose multille. Check if it is enough: sometimes it is natural."), preselect: false });
  }
  return out.sort((a, b) => a.from - b.from);
}

/** A cut asked for by word numbers (the assistant's tools): validated against the transcript. */
export function wordSpan(words: WordTiming[], fromWord: number, toWord: number): [number, number] {
  const a = Math.min(fromWord, toWord), b = Math.max(fromWord, toWord);
  if (a < 0 || b >= words.length) throw new Error(translate("The words go from # 0 to # {0}.", words.length - 1));
  return [a, b];
}

export function newProposal(assetId: string, kind: TranscriptCutKind, words: WordTiming[], range: [number, number], reason: string, texts?: string[]): TranscriptProposal {
  const [a, b] = range;
  const text = (texts ?? words.map((w) => w.text)).slice(a, b + 1).filter(Boolean).join(" ").slice(0, 600);
  return { id: `t-${crypto.randomUUID().slice(0, 8)}`, assetId, kind, from: round(words[a].start), to: round(Math.max(words[b].end, words[a].start + 0.01)), text, reason: reason.slice(0, 400), preselect: true };
}

// ---------------------------------------------------------------- for the assistant

const fmt = (n: number) => n.toFixed(2);

/**
 * The transcript as the assistant reads it: phrases with their word numbers and seconds (in the file and
 * in the montage), the words that are out of the montage and the long pauses. `detail: "words"` lists
 * every word.
 */
export function describeTranscript(doc: EditDocument, assetId: string, words: WordTiming[], options: { from?: number; to?: number; detail?: "phrases" | "words" } = {}): string {
  const placed = placeWords(doc, assetId, words);
  const from = options.from ?? 0, to = options.to ?? Infinity;
  const shown = placed.filter((w) => w.end >= from && w.start <= to);
  if (!shown.length) return translate("There are no words on that stretch.");
  if (options.detail === "words") {
    return shown.map((w) => `#${w.index} «${w.text || `(${words[w.index].text} → oculta)`}» ${fmt(w.start)}–${fmt(w.end)} ${w.at === null ? "FUERA" : translate("assembly {0}", fmt(w.at))}`).join("\n");
  }
  const lines: string[] = [];
  let group: PlacedWord[] = [];
  const flush = () => {
    if (!group.length) return;
    const first = group[0], last = group.at(-1)!;
    const inside = group.filter((w) => w.at !== null);
    const text = group.map((w, k) => {
      const out = w.at === null;
      const opens = out && (k === 0 || group[k - 1].at !== null), closes = out && (k === group.length - 1 || group[k + 1].at !== null);
      return `${opens ? "[quitado: " : ""}${w.text || ""}${closes ? "]" : ""}`;
    }).filter(Boolean).join(" ").replace(/\s+\]/g, "]");
    const where = inside.length ? translate("assembly {0} - {1}", fmt(inside[0].at!), fmt(inside.at(-1)!.until!)) : translate("OUTER THE MONTAJE");
    lines.push(`#${first.index}–#${last.index} · ${fmt(first.start)}–${fmt(last.end)} s (${where}): ${text}`);
    group = [];
  };
  shown.forEach((w, k) => {
    const next = shown[k + 1];
    group.push(w);
    const gap = next ? next.start - w.end : 0;
    if (!next || /[.!?…]["»”)]?$/.test(words[w.index].text) || gap >= DEFAULT_PAUSE || group.length >= 16) flush();
    if (next && gap >= DEFAULT_PAUSE) lines.push(translate("   · pause {0} s {1}", fmt(gap), w.at === null || next.at === null ? "" : translate(" (in assembly)")));
  });
  return lines.join("\n");
}

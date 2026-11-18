import type { WordTiming } from "@/lib/domain";
import type { CharAlignment } from "../tts/types";

const HAS_WORD_CHAR = /[\p{L}\p{N}]/u;
const round = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Character timings -> word timings (seconds from the start of the audio).
 * Words are split on whitespace and keep their punctuation ("¿Crees", "azul?").
 * Tokens with no letters or digits (a lone "—") are glued to the previous
 * word, or to the next one when they open the text, so every caption word
 * is speakable.
 */
export function charsToWords(alignment: Omit<CharAlignment, "type">): WordTiming[] {
  const { characters, starts, ends } = alignment;
  if (characters.length !== starts.length || characters.length !== ends.length) {
    throw new Error(
      `Alineación inconsistente: ${characters.length} caracteres, ${starts.length} inicios, ${ends.length} finales.`,
    );
  }

  const tokens: { text: string; start: number; end: number }[] = [];
  let current: { text: string; start: number; end: number } | null = null;
  for (let i = 0; i < characters.length; i++) {
    const ch = characters[i];
    if (/^\s+$/u.test(ch)) {
      if (current) tokens.push(current);
      current = null;
      continue;
    }
    if (!current) current = { text: ch, start: starts[i], end: ends[i] };
    else {
      current.text += ch;
      current.end = Math.max(current.end, ends[i]);
    }
  }
  if (current) tokens.push(current);

  const merged: { text: string; start: number; end: number }[] = [];
  let pendingPrefix: { text: string; start: number } | null = null;
  for (const token of tokens) {
    if (!HAS_WORD_CHAR.test(token.text)) {
      const prev = merged.at(-1);
      if (prev) {
        prev.text += ` ${token.text}`;
        prev.end = Math.max(prev.end, token.end);
      } else {
        pendingPrefix = pendingPrefix
          ? { text: `${pendingPrefix.text} ${token.text}`, start: pendingPrefix.start }
          : { text: token.text, start: token.start };
      }
      continue;
    }
    if (pendingPrefix) {
      merged.push({ text: `${pendingPrefix.text} ${token.text}`, start: pendingPrefix.start, end: token.end });
      pendingPrefix = null;
    } else {
      merged.push({ ...token });
    }
  }

  // Guarantee monotonic, non-negative windows even if the provider jitters.
  let lastStart = 0;
  return merged.map((w, i) => {
    const start = Math.max(lastStart, w.start, 0);
    const end = Math.max(start, w.end);
    lastStart = start;
    return { id: `w${i}`, text: w.text, start: round(start), end: round(end) };
  });
}

import type { EditOverlay } from "./schema";

/**
 * Keywords painted in an accent colour inside a subtitle («hoy os enseño **3** trucos»). An overlay lists
 * the words to mark; every renderer (the studio's canvas, the export) splits its text the same way, so a
 * word the user retypes keeps its colour while it is the same word.
 */

/** Yellow: what short videos use most for the highlighted word, readable over any picture with the outline. */
export const DEFAULT_ACCENT = "#ffd60a";

/** Case and punctuation do not count; accents do. */
export const emphasisKey = (text: string) => text.toLocaleLowerCase("es").replace(/[^\p{L}\p{N}]/gu, "");

/** The text in stretches to paint in the accent colour and the rest; spaces and line breaks are kept. */
export function emphasisRuns(o: Pick<EditOverlay, "text" | "emphasis">): { text: string; on: boolean }[] {
  const marks = new Set((o.emphasis ?? []).flatMap((w) => w.split(/\s+/)).map(emphasisKey).filter(Boolean));
  if (!marks.size) return [{ text: o.text, on: false }];
  const pieces = o.text.split(/(\s+)/).filter(Boolean);
  const marked = pieces.map((piece) => !/^\s+$/.test(piece) && marks.has(emphasisKey(piece)));
  // A space between two marked words is marked too: «Claude Code» is one coloured stretch.
  const on = pieces.map((piece, i) => marked[i] || (/^[ \t]+$/.test(piece) && !!marked[i - 1] && !!marked[i + 1]));
  const runs: { text: string; on: boolean }[] = [];
  pieces.forEach((piece, i) => {
    const last = runs.at(-1);
    if (last && last.on === on[i]) last.text += piece;
    else runs.push({ text: piece, on: on[i] });
  });
  return runs;
}

/** The text as HTML for the export, keywords in the accent colour. */
export function emphasisHtml(o: Pick<EditOverlay, "text" | "emphasis" | "accent">, escape: (text: string) => string): string {
  return emphasisRuns(o).map((r) => r.on ? `<span style="color:${o.accent ?? DEFAULT_ACCENT}">${escape(r.text)}</span>` : escape(r.text)).join("");
}

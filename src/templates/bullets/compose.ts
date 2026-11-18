import type { WordTiming } from "@/lib/domain";
import { normalizeWord } from "@/lib/pipeline/alignment/segments";
import { escapeHtml, jsonForScript, sec } from "@/lib/pipeline/composition/html";
import type { SceneComposer } from "../compose-types";

/**
 * When to reveal each item, in scene seconds: the moment the narration says
 * the item's first meaningful word (searched in order), falling back to an
 * even spread across the narration when it isn't found.
 */
export function bulletRevealTimes(
  items: string[],
  words: WordTiming[],
  narrationStart: number,
  sceneDuration: number,
): number[] {
  const norm = words.map((w) => normalizeWord(w.text));
  const speechEnd = words.at(-1)?.end ?? sceneDuration - narrationStart;
  let cursor = 0;
  const found = items.map((item) => {
    const keys = item
      .split(/\s+/)
      .map(normalizeWord)
      .filter((k) => k.length >= 3);
    const key = keys[0] ?? normalizeWord(item.split(/\s+/)[0] ?? "");
    for (let i = cursor; i < norm.length; i++) {
      if (key && (norm[i] === key || (key.length >= 5 && norm[i].startsWith(key.slice(0, 5))))) {
        cursor = i + 1;
        return narrationStart + words[i].start;
      }
    }
    return null;
  });

  const first = narrationStart + Math.min(0.6, speechEnd * 0.1);
  const span = Math.max(0.5, speechEnd * 0.85 - (first - narrationStart));
  const times = found.map((t, i) => t ?? first + (span * i) / Math.max(1, items.length - 1));

  // Keep order with a minimum gap, and leave every item on screen long enough
  // to read (≈1.9 s before the scene's exit), even if that means a bit early.
  const latest = Math.max(0.3, sceneDuration - 1.9);
  for (let i = times.length - 1; i >= 0; i--) {
    const cap = i === times.length - 1 ? latest : Math.min(latest, times[i + 1] - 0.25);
    times[i] = Math.min(times[i], cap);
  }
  for (let i = 1; i < times.length; i++) times[i] = Math.max(times[i], times[i - 1] + 0.25);
  return times.map(sec);
}

export const composeBullets: SceneComposer = ({ prefix, content, words, narrationStart, duration, layout }) => {
  const items = (Array.isArray(content.items) ? content.items : []).filter(Boolean);
  const longest = items.reduce((max, item) => Math.max(max, item.length), 0);
  return {
    heading: String(content.heading ?? "").trim(),
    headingSize: Math.round(44 * layout.scale),
    itemSize: Math.round((longest > 30 ? 38 : longest > 22 ? 42 : 48) * layout.scale),
    items: items
      .map(
        (item, i) =>
          `<li id="${prefix}-item-${i}"><span id="${prefix}-num-${i}" class="num">${i + 1}</span><span>${escapeHtml(item)}</span></li>`,
      )
      .join("\n        "),
    revealTimes: jsonForScript(bulletRevealTimes(items, words, narrationStart, duration)),
  };
};

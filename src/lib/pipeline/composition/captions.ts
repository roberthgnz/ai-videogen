import type { CaptionStyleId, VideoFormat, WordTiming } from "@/lib/domain";
import type { Theme } from "@/theme";
import { escapeHtml, jsonForScript, sec } from "./html";
import type { Layout } from "./layout";

export interface CaptionWord {
  text: string;
  start: number;
  end: number;
}

export interface CaptionGroup {
  start: number;
  end: number;
  words: CaptionWord[];
}

const SENTENCE_END = /[.!?…:;]["»”)]?$/;
const SOFT_BREAK = /[,—–]["»”)]?$/;

/**
 * Splits a scene's words (absolute seconds) into caption groups: at most
 * `maxWords` words and `maxChars` letters, breaking at sentence ends, after
 * commas once a group has 2+ words, and at pauses of 150 ms or more. Each
 * group stays on screen until the next one starts (or a short beat after its
 * last word), never past `sceneEnd`.
 */
export function buildCaptionGroups(
  words: CaptionWord[],
  maxWords: number,
  sceneEnd: number,
  maxChars = Infinity,
): CaptionGroup[] {
  const groups: CaptionGroup[] = [];
  let current: CaptionWord[] = [];
  let chars = 0;
  const close = () => {
    groups.push({ start: current[0].start, end: current.at(-1)!.end, words: current });
    current = [];
    chars = 0;
  };
  words.forEach((word, i) => {
    // A word that would make the line too long starts the next group (a single long word still gets its own).
    if (current.length > 0 && chars + word.text.length > maxChars) close();
    current.push(word);
    chars += word.text.length;
    const next = words[i + 1];
    const pause = next ? next.start - word.end : Infinity;
    if (
      !next ||
      current.length >= maxWords ||
      SENTENCE_END.test(word.text) ||
      (SOFT_BREAK.test(word.text) && current.length >= 2) ||
      pause >= 0.15
    ) {
      close();
    }
  });

  return groups.map((g, i) => {
    const next = groups[i + 1];
    const lastEnd = Math.max(g.end, g.words.at(-1)!.start + 0.08);
    const end = next ? Math.min(next.start, lastEnd + 0.6) : Math.min(sceneEnd, lastEnd + 0.6);
    return { ...g, start: sec(g.start), end: sec(Math.max(end, lastEnd)) };
  });
}

/** Words of every scene, shifted to absolute time; groups never span two scenes. */
export function captionGroupsForScenes(
  scenes: { start: number; narrationStart: number; end: number; words: WordTiming[] }[],
  maxWords: number,
  maxChars = Infinity,
): CaptionGroup[] {
  return scenes.flatMap((scene) =>
    buildCaptionGroups(
      scene.words.map((w) => ({
        text: w.text,
        start: sec(scene.narrationStart + w.start),
        end: sec(scene.narrationStart + Math.max(w.end, w.start)),
      })),
      maxWords,
      scene.end,
      maxChars,
    ),
  );
}

/** Group limits of a caption style for a format. */
export function captionLimits(theme: Theme, style: CaptionStyleId, format: VideoFormat) {
  const s = theme.captions.styles[style];
  return { maxWords: s.maxWords[format], maxChars: s.maxChars[format] };
}

/** Big punchy styles drop the commas and full stops that end a word; questions and exclamations stay. */
export function captionText(text: string, stripPunctuation: boolean): string {
  if (!stripPunctuation) return text;
  return text.replace(/[.,;:…]+(["»”)]?)$/, "$1") || text;
}

/**
 * The captions sub-composition: one single-line group visible at a time, the
 * spoken word marked the way the style says (colour, pop or a colour box).
 *
 * Words never overlap: they are flex items with a fixed gap, and a style that
 * enlarges the spoken word gives every word a side margin equal to how much
 * it grows, so the room is already there. Each group is sized to the caption
 * width, which sits inside the platforms' safe area.
 */
export function captionsHtml(
  groups: CaptionGroup[],
  theme: Theme,
  layout: Layout,
  duration: number,
  styleId: CaptionStyleId = "pop",
): string {
  const format: VideoFormat = layout.height > layout.width ? "vertical" : "horizontal";
  const style = theme.captions.styles[styleId];
  const { text: textColor, highlight, stroke } = theme.captions;
  const display = (w: CaptionWord) => captionText(w.text, style.stripPunctuation);
  const cased = (s: string) => (style.uppercase ? s.toUpperCase() : s);
  const box = styleId === "box";

  const groupsHtml = groups
    .map(
      (g, gi) =>
        `<div id="cg-${gi}" class="cg">${g.words
          .map(
            (w, wi) =>
              `<span id="cg-${gi}-${wi}" class="cw">${box ? `<span id="cb-${gi}-${wi}" class="cb"></span>` : ""}<span id="ct-${gi}-${wi}" class="ct">${escapeHtml(display(w))}</span></span>`,
          )
          .join("")}</div>`,
    )
    .join("\n    ");

  const data = groups.map((g) => ({
    s: g.start,
    e: g.end,
    // What the fit measures: the words as shown, with a separator as wide as the real gap.
    t: cased(g.words.map(display).join(box ? "n" : " ")),
    w: g.words.map((w, i) => {
      const next = g.words[i + 1];
      const end = Math.max(w.end, w.start + 0.08);
      // Hold the mark until the next word when they are close: no flicker between words.
      return [w.start, next ? Math.max(end, Math.min(next.start, end + 0.25)) : end + 0.12];
    }),
  }));

  const left = Math.round((layout.width - layout.captionMaxWidth) / 2);
  // paint-order draws the fill over the stroke, so only half of the stroke width shows outside the glyph.
  const outline = style.strokePx > 0 ? `-webkit-text-stroke: ${style.strokePx * 2}px ${stroke}; paint-order: stroke fill;` : "";
  const shadow = `0px ${Math.round(style.strokePx * 0.6) + 4}px ${style.strokePx + 10}px rgba(0, 0, 0, 0.55)`;

  return `<template>
  <style>
    #root { position: absolute; inset: 0; pointer-events: none; }
    .cg {
      position: absolute; left: ${left}px; width: ${layout.captionMaxWidth}px; bottom: var(--caption-bottom);
      display: flex; flex-wrap: nowrap; justify-content: center; align-items: baseline; column-gap: ${style.gapEm}em;
      opacity: 0; overflow: visible; white-space: nowrap; transform-origin: 50% 60%;
      font-family: "${style.font}", sans-serif; font-weight: ${style.weight};
      font-size: ${style.size[format]}px; line-height: 1.15; letter-spacing: ${style.uppercase ? "0.01em" : "-0.005em"};
      text-transform: ${style.uppercase ? "uppercase" : "none"}; color: ${textColor};
    }
    .cw { position: relative; display: block; flex: none; transform-origin: 50% 60%;${box ? " padding: 0.04em 0.2em;" : ""} }
    .ct { position: relative; display: block; color: ${textColor}; ${outline} text-shadow: ${shadow}; }
    .cb { position: absolute; inset: 0; border-radius: 0.2em; background: ${theme.captions.boxColor}; opacity: 0; transform-origin: 50% 50%; }
  </style>
  <div id="root" data-composition-id="captions" data-width="${layout.width}" data-height="${layout.height}">
    ${groupsHtml}
  </div>
  <script>
    (function () {
      var G = ${jsonForScript(data)};
      var STYLE = ${jsonForScript(styleId)};
      var HL = ${jsonForScript(highlight)};
      var TX = ${jsonForScript(textColor)};
      var BOXTX = ${jsonForScript(theme.captions.boxText)};
      var STROKE = ${jsonForScript(stroke)};
      var SHADOW = ${jsonForScript(shadow)};
      var NO_SHADOW = "0px 0px 0px rgba(0, 0, 0, 0)";
      var SCALE = ${style.activeScale};
      var MAXW = ${layout.captionMaxWidth};
      var BASE = ${style.size[format]};
      var MIN = ${style.minSize};
      var $ = function (id) { return document.getElementById(id); };

      // Sizes one group to the caption width and reserves the room its words need to grow.
      function layoutGroup(g, gi) {
        var el = $("cg-" + gi);
        var size = BASE;
        if (window.__hyperframes && window.__hyperframes.fitTextFontSize) {
          size = window.__hyperframes.fitTextFontSize(g.t, {
            fontFamily: ${jsonForScript(style.font)},
            fontWeight: ${style.weight},
            maxWidth: Math.floor(MAXW / SCALE),
            baseFontSize: BASE,
            minFontSize: MIN
          }).fontSize;
        }
        for (var pass = 0; pass < 3; pass++) {
          el.style.fontSize = size + "px";
          var first = null, last = null;
          g.w.forEach(function (_, wi) {
            var word = $("cg-" + gi + "-" + wi);
            word.style.margin = "0";
            var grow = word.offsetWidth * (SCALE - 1) / 2;
            word.style.margin = "0 " + grow.toFixed(2) + "px";
            if (!first) first = word;
            last = word;
          });
          if (!first) return;
          var total = last.offsetLeft + last.offsetWidth - first.offsetLeft + (first.offsetWidth + last.offsetWidth) * (SCALE - 1) / 2;
          if (total <= MAXW || size <= 24) return;
          size = Math.max(24, Math.floor(size * MAXW / total) - 1);
        }
      }
      function layoutAll() { G.forEach(layoutGroup); }
      layoutAll();
      // Measured again once the caption font is in, in case it arrived after this script.
      if (document.fonts && document.fonts.ready) document.fonts.ready.then(layoutAll);

      var tl = gsap.timeline({ paused: true });
      G.forEach(function (g, gi) {
        var el = $("cg-" + gi);
        if (STYLE === "pop") {
          tl.fromTo(el, { opacity: 0, scale: 0.62 }, { opacity: 1, scale: 1, duration: 0.16, ease: "back.out(2.2)" }, g.s);
        } else {
          tl.fromTo(el, { opacity: 0, y: 16 }, { opacity: 1, y: 0, duration: 0.14, ease: "power2.out" }, g.s);
        }
        g.w.forEach(function (w, wi) {
          var word = $("cg-" + gi + "-" + wi);
          var text = $("ct-" + gi + "-" + wi);
          if (STYLE === "box") {
            var box = $("cb-" + gi + "-" + wi);
            // On the box the word loses its outline and shadow: dark letters on the box colour read cleanly.
            tl.fromTo(box, { opacity: 0, scaleX: 0.82 }, { opacity: 1, scaleX: 1, duration: 0.09, ease: "power2.out" }, w[0]);
            tl.fromTo(
              text,
              { color: TX, webkitTextStrokeColor: STROKE, textShadow: SHADOW },
              { color: BOXTX, webkitTextStrokeColor: "rgba(0,0,0,0)", textShadow: NO_SHADOW, duration: 0.06, ease: "none" },
              w[0]
            );
            tl.to(box, { opacity: 0, duration: 0.08, ease: "power1.in" }, w[1]);
            tl.to(text, { color: TX, webkitTextStrokeColor: STROKE, textShadow: SHADOW, duration: 0.08, ease: "none" }, w[1]);
            return;
          }
          tl.fromTo(text, { color: TX }, { color: HL, duration: 0.06, ease: "none" }, w[0]);
          tl.to(text, { color: TX, duration: 0.1, ease: "none" }, w[1]);
          if (SCALE > 1) {
            tl.fromTo(word, { scale: 1 }, { scale: SCALE, duration: 0.1, ease: "back.out(3)" }, w[0]);
            tl.to(word, { scale: 1, duration: 0.1, ease: "power1.in" }, w[1]);
          }
        });
        tl.to(el, { opacity: 0, duration: 0.1, ease: "power2.in" }, Math.max(g.s + 0.15, g.e - 0.1));
        tl.set(el, { opacity: 0, visibility: "hidden" }, g.e);
      });
      tl.set({}, {}, ${sec(duration)});
      window.__timelines["captions"] = tl;
    })();
  </script>
</template>
`;
}

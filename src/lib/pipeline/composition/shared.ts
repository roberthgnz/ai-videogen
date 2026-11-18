import type { VisualKind } from "@/lib/domain";

/** A transition actually played between two scenes ("auto" and "cut" are resolved before). */
export type SceneTransition = "fade" | "slide" | "zoom";
import { escapeHtml, seededRandom } from "./html";
import type { Layout } from "./layout";

/**
 * Pieces every scene template shares: base styles, the animated gradient
 * background and the scene's exit. Positions come from a seeded PRNG so a
 * scene always renders the same.
 */

export const SCENE_BASE_CSS = `
#root { position: absolute; inset: 0; overflow: hidden; color: var(--text); font-family: var(--font-body); }
.bg { position: absolute; inset: 0; background: linear-gradient(170deg, var(--bg-top), var(--bg-bottom)); transform-origin: 50% 50%; }
.blob { position: absolute; border-radius: 50%; opacity: 0.55; }
.content {
  position: absolute; left: var(--safe-x); right: var(--safe-x);
  top: var(--content-top); bottom: var(--content-bottom);
  display: flex; flex-direction: column; justify-content: flex-start; gap: var(--gap);
}
.display { font-family: var(--font-display); font-weight: 900; line-height: 1.06; letter-spacing: -0.015em; margin: 0; }
.support { font-family: var(--font-display); font-weight: 700; line-height: 1.2; }
/* White text with a dark outline: readable over any footage without a box. */
/* The stroke is in em so it stays in proportion from a 40 px label to a 190 px figure (half of it shows). */
.outlined { -webkit-text-stroke: 0.18em var(--outline); paint-order: stroke fill; text-shadow: 0 0.06em 0.16em rgba(0, 0, 0, 0.5); }
/* Text on an accent label that follows the line breaks (the hook). */
.label-run {
  background: var(--accent); color: var(--on-accent); padding: 0.06em 0.3em; border-radius: 0.14em;
  -webkit-box-decoration-break: clone; box-decoration-break: clone;
}
h1:empty, h2:empty, p:empty, ul:empty { display: none; }
`;

/**
 * Font size for a text of unknown length: `steps` are [maxChars, px] pairs,
 * shortest first; the first one the text fits wins, scaled to the format.
 */
export function sizeFor(text: string, steps: [number, number][], layout: Layout): number {
  const px = (steps.find(([maxChars]) => text.length <= maxChars) ?? steps.at(-1)!)[1];
  return Math.round(px * layout.scale);
}

const BLOB_COLORS = ["var(--blob-a)", "var(--blob-b)", "var(--blob-c)"];

export function backgroundHtml(prefix: string): string {
  const blobs = BLOB_COLORS.map(
    (_, i) => `<div id="${prefix}-blob-${i}" class="blob" data-layout-ignore></div>`,
  ).join("\n    ");
  return `<div id="${prefix}-bg" class="bg" data-layout-ignore>
    ${blobs}
  </div>`;
}

/** Per-scene blob placement (CSS) and drift (GSAP tweens on `tl` over `duration`). */
export function backgroundParts(prefix: string, seed: number, layout: Layout, duration: number) {
  const rand = seededRandom(seed);
  const base = Math.max(layout.width, layout.height);
  const css: string[] = [];
  const tweens: string[] = [];
  BLOB_COLORS.forEach((color, i) => {
    const size = Math.round(base * (0.45 + rand() * 0.25));
    const left = Math.round(rand() * layout.width - size / 2);
    const top = Math.round(rand() * layout.height - size / 2);
    css.push(
      `#${prefix}-blob-${i} { width: ${size}px; height: ${size}px; left: ${left}px; top: ${top}px; background: radial-gradient(circle, ${color} 0%, transparent 68%); }`,
    );
    const dx = Math.round((rand() - 0.5) * base * 0.25);
    const dy = Math.round((rand() - 0.5) * base * 0.25);
    const s0 = (0.85 + rand() * 0.2).toFixed(2);
    const s1 = (1 + rand() * 0.25).toFixed(2);
    tweens.push(
      `tl.fromTo("#${prefix}-blob-${i}", { x: 0, y: 0, scale: ${s0} }, { x: ${dx}, y: ${dy}, scale: ${s1}, duration: ${duration.toFixed(3)}, ease: "sine.inOut" }, 0);`,
    );
  });
  return { css: css.join("\n"), tweens: tweens.join("\n    ") };
}

/** One full-screen shot of a scene's b-roll. Times are scene-local seconds. */
export interface BrollShot {
  /** Path of the normalized asset inside the build (already cropped to the frame). */
  src: string;
  kind: VisualKind;
  start: number;
  duration: number;
}

/**
 * B-roll background: one muted clip (or still) per shot, hard cuts between
 * them, a slow zoom on each so nothing sits still, and a dark gradient on top
 * so titles and captions stay readable over any footage.
 */
export function brollParts(prefix: string, seed: number, layout: Layout, shots: BrollShot[]) {
  const rand = seededRandom(seed);
  const size = `width: ${layout.width}px; height: ${layout.height}px;`;
  const clips = shots
    .map((shot, i) => {
      const timing = `data-start="${shot.start}" data-duration="${shot.duration}" data-track-index="0" data-hf-media-start-basis="local"`;
      const media =
        shot.kind === "video"
          ? `<video id="${prefix}-clip-${i}" class="clip" src="${escapeHtml(shot.src)}" muted playsinline preload="auto" ${timing}></video>`
          : `<img id="${prefix}-clip-${i}" class="clip" src="${escapeHtml(shot.src)}" alt="" ${timing} />`;
      return `<div id="${prefix}-shot-${i}" class="shot">${media}</div>`;
    })
    .join("\n    ");
  const html = `<div id="${prefix}-bg" class="bg broll" data-layout-ignore>
    ${clips}
    <div class="scrim"></div>
  </div>`;

  const vertical = layout.height > layout.width;
  // Darkest where text sits: the title band at the top and the caption band below the middle.
  const scrim = vertical
    ? "linear-gradient(to bottom, rgba(4,5,12,0.46) 0%, rgba(4,5,12,0.22) 26%, rgba(4,5,12,0.14) 44%, rgba(4,5,12,0.38) 60%, rgba(4,5,12,0.44) 76%, rgba(4,5,12,0.58) 100%)"
    : "linear-gradient(to bottom, rgba(4,5,12,0.42) 0%, rgba(4,5,12,0.18) 40%, rgba(4,5,12,0.36) 70%, rgba(4,5,12,0.62) 100%)";
  const css = `#${prefix}-bg { background: #000; }
#${prefix}-bg .shot { position: absolute; left: 0; top: 0; ${size} transform-origin: 50% 50%; }
#${prefix}-bg .clip { position: absolute; left: 0; top: 0; ${size} object-fit: cover; }
#${prefix}-bg .scrim { position: absolute; inset: 0; background: ${scrim}; }
`;

  const zoomInFirst = rand() < 0.5;
  const tweens = shots.map((shot, i) => {
    // Stills need more movement than footage that already moves.
    const amount = shot.kind === "image" ? 0.14 : 0.07;
    const zoomIn = (i % 2 === 0) === zoomInFirst;
    const from = zoomIn ? 1.02 : 1.02 + amount;
    const to = zoomIn ? 1.02 + amount : 1.02;
    const drift = Math.round((rand() - 0.5) * layout.width * 0.02);
    return `tl.fromTo("#${prefix}-shot-${i}", { scale: ${from.toFixed(3)}, x: ${-drift} }, { scale: ${to.toFixed(3)}, x: ${drift}, duration: ${shot.duration.toFixed(3)}, ease: "none" }, ${shot.start.toFixed(3)});`;
  });
  return { html, css, tweens: tweens.join("\n      ") };
}

/** Fades the scene's content out just before the cut (not on the last scene). */
export function exitTween(prefix: string, duration: number, isLast: boolean): string {
  if (isLast) return "";
  const at = Math.max(0, duration - 0.32).toFixed(3);
  return `tl.to("#${prefix}-content", { opacity: 0, y: -24, duration: 0.25, ease: "power2.in" }, ${at});`;
}

/** How long two scenes overlap during a transition. */
export const TRANSITION_SEC = 0.3;

/**
 * Transition tweens for one scene's background. `out` runs after the scene's
 * own duration, while the next scene is already playing underneath; `in` runs
 * at the start, under the previous scene's exit. Both move the same way, so
 * the two halves read as one move.
 */
export function transitionTweens(
  prefix: string,
  duration: number,
  kinds: { in: SceneTransition | null; out: SceneTransition | null },
): string {
  const bg = `"#${prefix}-bg"`;
  const t = TRANSITION_SEC;
  const lines: string[] = [];
  if (kinds.in === "slide") lines.push(`tl.fromTo(${bg}, { xPercent: 100 }, { xPercent: 0, duration: ${t}, ease: "power3.inOut" }, 0);`);
  if (kinds.in === "zoom") lines.push(`tl.fromTo(${bg}, { scale: 1.22 }, { scale: 1, duration: ${t + 0.12}, ease: "power2.out" }, 0);`);
  const at = duration.toFixed(3);
  if (kinds.out === "fade") lines.push(`tl.to(${bg}, { opacity: 0, duration: ${t}, ease: "power1.inOut" }, ${at});`);
  if (kinds.out === "slide") lines.push(`tl.to(${bg}, { xPercent: -100, duration: ${t}, ease: "power3.inOut" }, ${at});`);
  if (kinds.out === "zoom") lines.push(`tl.to(${bg}, { scale: 1.9, opacity: 0, duration: ${t}, ease: "power2.in" }, ${at});`);
  return lines.join("\n      ");
}

/** Splits text into word spans for staggered entrances. */
export function wordSpans(text: string, prefix: string, escape: (s: string) => string): string {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((w, i) => `<span id="${prefix}-${i}" class="w">${escape(w)}</span>`)
    .join(" ");
}

/**
 * Video theme: the one place to change colours, typography and caption style.
 * Every template and the caption layer read these values as CSS variables
 * (see src/lib/pipeline/composition/theme-css.ts).
 *
 * Fonts: use a family HyperFrames bundles (Inter, Montserrat, Outfit, Nunito,
 * Oswald, League Gothic, Archivo Black, Poppins, Roboto, Open Sans, Lato,
 * Playfair Display, EB Garamond, Space Mono, JetBrains Mono, ...). Any other
 * family needs an @font-face pointing at a file in the build's assets/fonts/.
 */
export const theme = {
  colors: {
    /** Scene background, top and bottom of the gradient. */
    backgroundTop: "#14122B",
    backgroundBottom: "#07070F",
    /** Soft animated shapes behind the content. */
    blobA: "#6C4DFF",
    blobB: "#FF4D8D",
    blobC: "#21C7B7",
    text: "#F7F7FB",
    textMuted: "#C9C7E0",
    /** Accent for bars, bullets, CTA. */
    accent: "#FFD23F",
    /** Text drawn on top of the accent colour. */
    onAccent: "#14122B",
    /** Card/list item surface. */
    surface: "rgba(255, 255, 255, 0.08)",
    /** List chips drawn over footage. */
    chip: "rgba(10, 11, 20, 0.78)",
    /** Outline of on-screen text drawn over footage. */
    outline: "#0B0B12",
  },
  fonts: {
    display: "Montserrat",
    body: "Inter",
  },
  captions: {
    text: "#FFFFFF",
    /** Colour of the word being spoken ("pop" and "line"). */
    highlight: "#FFD23F",
    /** Outline around the letters. */
    stroke: "#0B0B12",
    /** "box" style: the box behind the spoken word, and the text on it. */
    boxColor: "#FFD23F",
    boxText: "#14122B",
    /**
     * One entry per caption style. Sizes are px at 1080x1920 / 1920x1080 and
     * shrink per group when a line would not fit the safe width.
     * `strokePx` is the visible outline thickness; `activeScale` how much the
     * spoken word grows (1 = it does not); `gapEm` the space between words.
     */
    styles: {
      pop: {
        font: "Montserrat",
        weight: 900,
        uppercase: true,
        stripPunctuation: true,
        maxWords: { vertical: 3, horizontal: 4 },
        maxChars: { vertical: 12, horizontal: 20 },
        size: { vertical: 124, horizontal: 104 },
        minSize: 64,
        strokePx: 12,
        activeScale: 1.1,
        gapEm: 0.26,
      },
      line: {
        font: "Montserrat",
        weight: 800,
        uppercase: false,
        stripPunctuation: false,
        maxWords: { vertical: 4, horizontal: 6 },
        maxChars: { vertical: 22, horizontal: 38 },
        size: { vertical: 70, horizontal: 62 },
        minSize: 44,
        strokePx: 6,
        activeScale: 1,
        gapEm: 0.27,
      },
      box: {
        font: "Montserrat",
        weight: 800,
        uppercase: true,
        stripPunctuation: true,
        maxWords: { vertical: 3, horizontal: 5 },
        maxChars: { vertical: 16, horizontal: 28 },
        size: { vertical: 82, horizontal: 70 },
        minSize: 48,
        strokePx: 5,
        activeScale: 1,
        gapEm: 0.02,
      },
    },
  },
  audio: {
    /** Music level (0-1) when nobody speaks, and under the voice. */
    musicFull: 0.55,
    musicDucked: 0.14,
    /** Seconds the music takes to duck before a phrase and to come back after it. */
    duckAttack: 0.25,
    duckRelease: 0.5,
    /** Pauses shorter than this (seconds) do not bring the music back up. */
    duckMinGap: 0.9,
    musicFadeIn: 0.4,
    musicFadeOut: 1.5,
    /** Transition effects: level, and how long before the scene change they start. */
    sfxVolume: 0.45,
    sfxLead: 0.12,
    /** Loudness of the finished MP4 (social platforms play at about -14 LUFS). */
    target: { lufs: -14, truePeakDb: -1 },
  },
  timing: {
    /** Silence before each scene's narration, seconds. */
    sceneLead: 0.15,
    /** Silence after each scene's narration, seconds. */
    sceneTail: 0.35,
  },
};

export type Theme = typeof theme;

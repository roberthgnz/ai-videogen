import { FORMAT_SIZE, type VideoFormat } from "@/lib/domain";
import type { Theme } from "@/theme";

/**
 * Per-format layout. In vertical everything readable stays inside `safe`,
 * the area TikTok, Reels and Shorts leave free of their own UI (title bar on
 * top; caption, account and audio rows at the bottom; the button rail on the
 * right). Captions sit centred in the lower half of that area.
 */
export interface Layout {
  width: number;
  height: number;
  safeX: number;
  contentTop: number;
  /** Distance from the bottom of the frame to the bottom of the content area. */
  contentBottom: number;
  /** Distance from the bottom of the frame to the bottom of the caption line. */
  captionBottom: number;
  /** Widest a caption line may be; centred, so it clears the right-hand button rail. */
  captionMaxWidth: number;
  /** Margins (px) the platforms' own UI covers. */
  safe: { top: number; bottom: number; left: number; right: number };
  /** Multiplier for on-screen text sizes, which are designed at 1080 px wide. */
  scale: number;
  gap: number;
}

export function layoutFor(format: VideoFormat): Layout {
  const { width, height } = FORMAT_SIZE[format];
  if (format === "vertical") {
    return {
      width,
      height,
      safeX: 110,
      contentTop: 260,
      contentBottom: 940,
      captionBottom: 590,
      captionMaxWidth: 840,
      safe: { top: 250, bottom: 480, left: 60, right: 120 },
      scale: 1,
      gap: 36,
    };
  }
  return {
    width,
    height,
    safeX: 170,
    contentTop: 100,
    contentBottom: 300,
    captionBottom: 90,
    captionMaxWidth: 1500,
    safe: { top: 60, bottom: 60, left: 100, right: 100 },
    scale: 0.9,
    gap: 32,
  };
}

/** The theme and layout as CSS custom properties, set once on the root document. */
export function themeCss(theme: Theme, layout: Layout): string {
  const c = theme.colors;
  const vars: Record<string, string> = {
    "--bg-top": c.backgroundTop,
    "--bg-bottom": c.backgroundBottom,
    "--blob-a": c.blobA,
    "--blob-b": c.blobB,
    "--blob-c": c.blobC,
    "--text": c.text,
    "--text-muted": c.textMuted,
    "--accent": c.accent,
    "--on-accent": c.onAccent,
    "--surface": c.surface,
    "--chip": c.chip,
    "--outline": c.outline,
    "--font-display": `"${theme.fonts.display}", sans-serif`,
    "--font-body": `"${theme.fonts.body}", sans-serif`,
    "--safe-x": `${layout.safeX}px`,
    "--content-top": `${layout.contentTop}px`,
    "--content-bottom": `${layout.contentBottom}px`,
    "--caption-bottom": `${layout.captionBottom}px`,
    "--gap": `${layout.gap}px`,
  };
  return `:root {\n${Object.entries(vars)
    .map(([k, v]) => `  ${k}: ${v};`)
    .join("\n")}\n}`;
}

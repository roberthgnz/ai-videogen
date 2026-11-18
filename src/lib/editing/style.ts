import type { CSSProperties } from "react";
import type { EditOverlay } from "./schema";

/** Canvas uses output coordinates and scales as a whole, including text and padding. */
export function overlayStyle(o: EditOverlay): CSSProperties {
  return { position: "absolute", left: `${o.x}%`, top: `${o.y}%`, width: `${o.width}%`, fontSize: `${o.fontSize}px`,
    color: o.color, background: o.background, textAlign: o.align, whiteSpace: "pre-wrap", overflowWrap: "anywhere",
    fontFamily: o.fontFamily === "serif" ? "Georgia, 'Times New Roman', serif"
      : o.fontFamily === "mono" ? "'Courier New', monospace"
      : o.fontWeight && o.fontWeight !== 700 ? "Arial, sans-serif" : "VideoGenCanvas, sans-serif",
    fontStyle: o.fontStyle ?? "normal", fontWeight: o.fontWeight ?? 700,
    lineHeight: 1.18, padding: "0.3em", boxSizing: "border-box", margin: 0 };
}

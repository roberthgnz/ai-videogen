import { localizedLabels } from "@/lib/i18n";
import type { CaptionStyleId, TransitionId } from "@/lib/domain";
import { theme, type Theme } from "@/theme";

/**
 * Style presets: one click sets the caption look, the transitions and the
 * accent colours of a video. Caption style and transition stay editable
 * afterwards; the colours always come from the preset. Client-safe.
 */
export const PRESET_IDS = ["viral", "limpio", "impacto"] as const;
export type PresetId = (typeof PRESET_IDS)[number];

export interface StylePreset {
  label: string;
  hint: string;
  captionStyle: CaptionStyleId;
  transition: TransitionId;
  /** Accent of labels, bars, buttons and the spoken word. */
  accent: string;
  /** Text drawn on top of the accent. */
  onAccent: string;
}

export const STYLE_PRESETS: Record<PresetId, StylePreset> = localizedLabels((translate) => ({
  viral: {
    label: "Viral",
    hint: translate("Giant words in yellow, varied transitions"),
    captionStyle: "pop",
    transition: "auto",
    accent: "#FFD23F",
    onAccent: "#14122B",
  },
  limpio: {
    label: translate("Clean"),
    hint: translate("Frase with the word in blue, fused"),
    captionStyle: "line",
    transition: "fade",
    accent: "#5CC8FF",
    onAccent: "#06121C",
  },
  impacto: {
    label: "Impacto",
    hint: translate("Red box after the word, zoom"),
    captionStyle: "box",
    transition: "zoom",
    accent: "#FF4D5E",
    onAccent: "#FFFFFF",
  },
}));

export const DEFAULT_PRESET: PresetId = "viral";

/** The video theme with a preset's colours applied. */
export function themeForPreset(id: PresetId): Theme {
  const preset = STYLE_PRESETS[id] ?? STYLE_PRESETS[DEFAULT_PRESET];
  return {
    ...theme,
    colors: { ...theme.colors, accent: preset.accent, onAccent: preset.onAccent },
    captions: { ...theme.captions, highlight: preset.accent, boxColor: preset.accent, boxText: preset.onAccent },
  };
}

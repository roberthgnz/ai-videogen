import { t as translate, localizedLabels } from "@/lib/i18n";
import { z } from "zod";

/**
 * «Mi estilo»: what the user wants in every video, whatever the project: colours, fonts, logos, the pace of the
 * cut, how subtitles look and where they sit, how many graphics, and free rules («sin emojis»). There can be
 * several (one per brand or client); each project picks one. Client-safe: shapes, labels and pure helpers.
 */

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a color like # 1A2B3C.");

export const FONT_FAMILIES = ["sans", "serif", "mono"] as const;
export type FontFamily = (typeof FONT_FAMILIES)[number];
export const FONT_FAMILY_LABELS: Record<FontFamily, string> = localizedLabels((translate) => ({ sans: translate("Not containing added sugar"), serif: translate("Serif"), mono: translate("Monospace") }));
export const FONT_WEIGHTS = [400, 500, 600, 700, 800, 900] as const;
export const FONT_WEIGHT_LABELS: Record<number, string> = localizedLabels((translate) => ({ 400: "Normal", 500: translate("Medium"), 600: translate("Semibold"), 700: translate("Bold"), 800: translate("Extra bold"), 900: translate("Black") }));

/** How fast the cut goes. null: no preference (each video decides). */
export const STYLE_PACES = ["fast", "medium", "calm"] as const;
export type StylePace = (typeof STYLE_PACES)[number];
export const PACE_INFO: Record<StylePace, { label: string; hint: string; seconds: number }> = localizedLabels((translate) => ({
  fast: { label: translate("Quick"), hint: translate("Bars of less than 1,5 s"), seconds: 1.2 },
  medium: { label: translate("Medium"), hint: translate("One plane every 2-3 s"), seconds: 2.5 },
  calm: { label: "Pausado", hint: translate("Plane of 4 s or more"), seconds: 4.5 },
}));

/** How much on-screen graphics (titles, labels, cards) a video carries. null: no preference. */
export const GRAPHICS_DENSITIES = ["none", "few", "some", "many"] as const;
export type GraphicsDensity = (typeof GRAPHICS_DENSITIES)[number];
export const GRAPHICS_INFO: Record<GraphicsDensity, { label: string; hint: string }> = localizedLabels((translate) => ({
  none: { label: translate("No graphics"), hint: translate("Only image and, if any, subtitles") },
  few: { label: "Pocos", hint: translate("A title or sign at key moments") },
  some: { label: "Algunos", hint: translate("Titles and signs that accompany each idea") },
  many: { label: "Muchos", hint: translate("Graphics on almost every plane") },
}));

/** Whether videos carry subtitles: «auto» leaves it to the request and the references. */
export const CAPTION_USES = ["auto", "always", "never"] as const;
export type CaptionUse = (typeof CAPTION_USES)[number];
export const CAPTION_USE_LABELS: Record<CaptionUse, string> = localizedLabels((translate) => ({ auto: translate("According to the video"), always: translate("Always"), never: translate("Never") }));

/** Where a rule came from: written by the user, learned from a correction in a project, or read from references. */
export const RULE_SOURCES = ["manual", "learned", "references"] as const;
export type RuleSource = (typeof RULE_SOURCES)[number];

export const fontSchema = z.object({
  family: z.enum(FONT_FAMILIES).default("sans"),
  weight: z.number().int().min(100).max(900).default(700),
  italic: z.boolean().default(false),
  /** The exact font the user wants (e.g. «Bebas Neue»), if any: the agent uses the closest it has. */
  name: z.string().trim().max(60).default(""),
});
export type StyleFont = z.infer<typeof fontSchema>;

export const styleColorSchema = z.object({ hex, role: z.string().trim().max(40).default("") });
export type StyleColor = z.infer<typeof styleColorSchema>;

/** A logo from the global library: the profile keeps its library id and path, the project imports it when used. */
export const styleLogoSchema = z.object({
  assetId: z.string().min(1).max(80),
  name: z.string().max(240),
  path: z.string().max(500),
  /** Where and when it goes, in the user's words (e.g. «esquina superior derecha, solo al final»). */
  placement: z.string().trim().max(200).default(""),
});
export type StyleLogo = z.infer<typeof styleLogoSchema>;

export const styleRuleSchema = z.object({
  id,
  text: z.string().trim().min(3, "Write the rule.").max(300),
  source: z.enum(RULE_SOURCES).default("manual"),
  /** The project it was learned in, for «Aprendida en …». */
  projectId: z.string().max(80).optional(),
  projectTitle: z.string().max(160).optional(),
  createdAt: z.number().int().nonnegative(),
});
export type StyleRule = z.infer<typeof styleRuleSchema>;

export const styleCaptionsSchema = z.object({
  use: z.enum(CAPTION_USES).default("auto"),
  wordsPerCue: z.number().int().min(1).max(16).default(3),
  /** Top of the subtitle box, in % of the canvas height (0 = top edge). */
  y: z.number().min(0).max(95).default(75),
  fontSize: z.number().min(12).max(200).default(48),
  color: hex.default("#ffffff"),
  background: z.union([z.literal("transparent"), hex]).default("transparent"),
  /** Colour for the key word of each subtitle; empty: none. */
  highlight: z.union([z.literal(""), hex]).default(""),
  uppercase: z.boolean().default(false),
  notes: z.string().trim().max(600).default(""),
});
export type StyleCaptions = z.infer<typeof styleCaptionsSchema>;

export const styleProfileSchema = z.object({
  id,
  name: z.string().trim().min(1, "Give him a name.").max(80),
  /** Brand and tone of voice, in the user's words. */
  brand: z.string().trim().max(800).default(""),
  /** The look: framing, colour grade, transitions, camera moves. */
  look: z.string().trim().max(1200).default(""),
  colors: z.array(styleColorSchema).max(8).default([]),
  fonts: z.object({ titles: fontSchema.prefault({ weight: 800 }), text: fontSchema.prefault({}) }).prefault({}),
  logos: z.array(styleLogoSchema).max(6).default([]),
  pacing: z.object({
    pace: z.enum(STYLE_PACES).nullable().default(null),
    /** Usual shot length to aim for; null: what the pace says. */
    shotSeconds: z.number().min(0.2).max(30).nullable().default(null),
    notes: z.string().trim().max(800).default(""),
  }).prefault({}),
  captions: styleCaptionsSchema.prefault({}),
  graphics: z.object({
    density: z.enum(GRAPHICS_DENSITIES).nullable().default(null),
    notes: z.string().trim().max(600).default(""),
  }).prefault({}),
  sound: z.string().trim().max(800).default(""),
  rules: z.array(styleRuleSchema).max(80).default([]),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});
export type StyleProfile = z.infer<typeof styleProfileSchema>;
/** What the editor sends: the profile without its timestamps (the store sets them). */
export type StyleProfileDraft = Omit<StyleProfile, "createdAt" | "updatedAt"> & Partial<Pick<StyleProfile, "createdAt" | "updatedAt">>;

/** A rule the agent suggests after a correction; it only enters a profile when the user accepts it. */
export const ruleProposalSchema = z.object({
  id,
  projectId: z.string().max(80),
  text: z.string().trim().min(3).max(300),
  /** Why it would help every video, in one sentence for the user. */
  reason: z.string().trim().max(300).default(""),
  createdAt: z.number().int().nonnegative(),
});
export type RuleProposal = z.infer<typeof ruleProposalSchema>;

/** A new, empty profile: every field at «no preference». */
export function blankProfile(id: string, name = translate("My style"), now = 0): StyleProfile {
  return styleProfileSchema.parse({ id, name, createdAt: now, updatedAt: now });
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** One line to recognise a profile in a list: «3 colores · Ritmo rápido · Subtítulos abajo · 4 reglas». */
export function profileSummary(p: StyleProfile): string {
  const parts: string[] = [];
  if (p.colors.length) parts.push(plural(p.colors.length, "color", "colores"));
  if (p.logos.length) parts.push(plural(p.logos.length, "logo", "logos"));
  if (p.pacing.pace) parts.push(translate("{0} pacing", PACE_INFO[p.pacing.pace].label.toLowerCase()));
  if (p.captions.use === "never") parts.push(translate("No subtitles"));
  else parts.push(translate("Subtitles {0}", captionPlace(p.captions.y)));
  if (p.graphics.density) parts.push(p.graphics.density === "none" ? translate("No graphics") : translate("{0} graphics", GRAPHICS_INFO[p.graphics.density].label));
  if (p.rules.length) parts.push(plural(p.rules.length, "regla", "reglas"));
  return parts.join(" · ");
}

/** «arriba», «en el centro» or «abajo», from the top of the subtitle box. */
export function captionPlace(y: number): string {
  return y < 30 ? "arriba" : y < 58 ? translate("in the center") : "abajo";
}

const font = (f: StyleFont) => `${FONT_FAMILY_LABELS[f.family].toLowerCase()} ${f.weight}${f.italic ? " cursiva" : ""}${f.name ? translate(" (wants to \"{0}\": use the most similar you have)", f.name) : ""}`;

/**
 * The profile as the agent reads it, field by field. Only what the user set: a field with no
 * preference is left out, so the agent decides it from the request and the references.
 */
export function describeProfile(p: StyleProfile): string {
  const lines: string[] = [];
  if (p.brand) lines.push(`- Marca y tono: ${p.brand}`);
  if (p.look) lines.push(translate("- What do you mean? {0}", p.look));
  if (p.colors.length) lines.push(`- Colores: ${p.colors.map((c) => `${c.hex}${c.role ? ` (${c.role})` : ""}`).join(", ")}.`);
  lines.push(translate("- Sources: titles {0}; texts and subtitles {1}In. place_text: fontFamily, fontWeight and fontStyle.", font(p.fonts.titles), font(p.fonts.text)));
  if (p.logos.length) lines.push(`- Logos (de la biblioteca; ponlos con use_style_logo): ${p.logos.map((l) => `«${l.name}» [assetId ${l.assetId}]${l.placement ? `: ${l.placement}` : ""}`).join("; ")}.`);
  const pace = p.pacing.pace ? `${PACE_INFO[p.pacing.pace].label.toLowerCase()} (${PACE_INFO[p.pacing.pace].hint.toLowerCase()})` : "";
  const shot = p.pacing.shotSeconds ? translate("normal plane of {0} s", p.pacing.shotSeconds) : "";
  if (pace || shot || p.pacing.notes) lines.push(translate("- Mounting speed: {0}.", [pace, shot, p.pacing.notes].filter(Boolean).join("; ")));
  const c = p.captions;
  if (c.use === "never") lines.push(translate("- Subtitles: NUNCA, unless requested by the user in this project. {0}", c.notes ? ` ${c.notes}` : ""));
  else lines.push(translate("- Subtitles {0}: {1} words by subtitle; and = {2} ({3}), fontSize {4}, color {5}, background {6} {7} {8}. {9}", c.use === "always" ? translate(" (SIGHS there's a voice)") : translate(" (if the video takes them)"), c.wordsPerCue, c.y, captionPlace(c.y), c.fontSize, c.color, c.background, c.highlight ? translate(", keyword in {0}", c.highlight) : "", c.uppercase ? translate("in Mayúsculas") : "", c.notes ? ` ${c.notes}` : ""));
  if (p.graphics.density || p.graphics.notes) lines.push(translate("- Graphics and signs: {0}.", [p.graphics.density ? `${GRAPHICS_INFO[p.graphics.density].label} (${GRAPHICS_INFO[p.graphics.density].hint.toLowerCase()})` : "", p.graphics.notes].filter(Boolean).join("; ")));
  if (p.sound) lines.push(`- Sonido: ${p.sound}`);
  if (p.rules.length) lines.push(translate("- User rules (all of them):\n{0}", p.rules.map((r, i) => `  ${i + 1}. ${r.text}`).join("\n")));
  return lines.join("\n");
}

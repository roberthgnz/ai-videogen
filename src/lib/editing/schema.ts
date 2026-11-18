import { t as translate } from "@/lib/i18n";
import { z } from "zod";
import { CLIP_MOTIONS, CLIP_TRANSITIONS } from "./motion";
import { transcriptStateSchema } from "./transcript-schema";

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
const seconds = z.number().finite().min(0).max(7200);
/** Row of the timeline, per kind of element (0 = main). Picture clips on a higher track cover the ones below. */
const track = z.number().int().min(0).max(49).optional()
  .describe("Optional timeline track (0 is the main track). A higher video track covers the ones below it.");
export const assetSchema = z.object({
  id, name: z.string().max(240), kind: z.enum(["video", "audio", "image", "document"]),
  path: z.string().max(500), duration: seconds, width: z.number().nonnegative(), height: z.number().nonnegative(),
  hasAudio: z.boolean(), context: z.string().max(16000).default(""),
});
export const editClipSchema = z.object({
  id, assetId: id, start: seconds, in: seconds, duration: z.number().finite().min(0.04).max(7200),
  volume: z.number().min(0).max(1), fit: z.enum(["contain", "cover"]),
  /** How the clip arrives (picture clips only) and the slow camera move over it. See motion.ts. */
  transition: z.enum(CLIP_TRANSITIONS).default("cut"), motion: z.enum(CLIP_MOTIONS).default("none"),
  /** Playback speed (1 = as filmed). The clip lasts `duration` on the timeline and uses `duration * speed` seconds of the file. */
  speed: z.number().min(0.25).max(4).optional(),
  track,
});
export const overlaySchema = z.object({
  id, text: z.string().min(1).max(1000), start: seconds, duration: z.number().finite().min(0.04).max(7200),
  x: z.number().min(0).max(100), y: z.number().min(0).max(100), width: z.number().min(5).max(100),
  fontSize: z.number().min(12).max(200), color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  background: z.string().regex(/^(transparent|#[0-9a-fA-F]{6})$/),
  align: z.enum(["left", "center", "right"]), kind: z.enum(["text", "caption"]),
  fontFamily: z.enum(["sans", "serif", "mono"]).optional(),
  fontStyle: z.enum(["normal", "italic"]).optional(),
  fontWeight: z.number().int().min(100).max(900).optional(),
  track,
  /** Keywords painted in `accent` (see emphasis.ts). */
  emphasis: z.array(z.string().max(80)).max(20).optional(),
  accent: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  /** Ownership survives manual text/timing changes; never infer another speaker's captions by overlap. */
  transcriptSource: z.object({ assetId: id, words: z.array(z.number().int().nonnegative()).max(1000) }).optional(),
});
/** Shared by narrated captions and reference analysis; coordinates use the output canvas. */
export const captionAppearanceSchema = overlaySchema.pick({ x: true, y: true, width: true, fontSize: true, color: true, background: true, align: true, fontFamily: true, fontStyle: true, fontWeight: true });
export type CaptionAppearance = z.infer<typeof captionAppearanceSchema>;
/** Creative decisions, made from the user's request first and their references second. */
export const videoDirectionSchema = z.object({
  voiceover: z.boolean().describe("Add voiceover when requested or supported by the reference and consistent with the prompt"),
  captions: z.boolean().describe("Add subtitles when requested or supported by the reference. Treat subtitles and voiceover as independent choices."),
  titles: z.boolean().describe("Add titles or labels where they fit the prompt and reference"),
  music: z.boolean().describe("Add music only if justified by the prompt or reference"),
  sfx: z.boolean().describe("Add sound effects only if they fit the requested style"),
});
export const referenceAnalysisSchema = z.object({
  visualStyle: z.string().min(20).max(1600).describe("Timestamped observations on framing, color, transitions, motion, and typography. Separate visible details from assumptions."),
  /** What the picture is made of. A drawn reference is redone with the agent's own graphics, never covered with stock footage. */
  imagery: z.object({
    kind: z.enum(["footage", "graphics", "mixed"]).describe("Use footage for filmed or photographed imagery, graphics for created visuals such as illustration, collage, or motion graphics, and mixed for both."),
    recipe: z.string().max(1200).describe("For graphics, describe how to recreate the palette in hex, backgrounds, textures, shapes, edges, type, labels, composition, and motion with create_graphic. Leave empty for footage alone."),
  }).optional(),
  pacing: z.object({
    shotSeconds: z.number().min(0.15).max(60).describe("Typical shot duration to use, based on the cuts in the reference"),
    progression: z.string().min(10).max(800).describe("How pacing changes from the hook through development to the ending"),
  }),
  text: z.object({
    mode: z.enum(["none", "captions", "titles", "both"]),
    appearance: captionAppearanceSchema,
    wordsPerCue: z.number().int().min(1).max(16),
    treatment: z.string().min(10).max(1000).describe("Readable text and timestamps, hierarchy, backgrounds, typographic style, and ways to adapt them. Distinguish signs in the footage from added titles."),
  }),
  story: z.array(z.object({
    from: seconds, to: seconds,
    purpose: z.string().min(3).max(300).describe("What this segment does in the narrative, such as setting up a promise, giving context, explaining, proving, or delivering a payoff"),
    adaptation: z.string().min(5).max(600).describe("What this video will say or show to serve the same purpose using its own material"),
  }).refine((s) => s.to > s.from, { error: () => translate("The segment must have a positive duration.") })).max(16).describe("Segments of a narrative reference. Leave empty for images or references without a narrative."),
  audio: z.string().min(10).max(1000).describe("Tone, speech density, pauses, and music. Note what could not be heard or isolated."),
  limitations: z.string().max(1000).describe("Differences or unavailable resources that limit adaptation. Leave empty when there are none."),
});
/**
 * What a reference guides: the look and pace of the cut (style), the words and structure (script),
 * the brand (colors, logo, tone of voice) or the product shown (real UI, features). One reference can
 * guide several, e.g. a video whose editing AND script the user likes.
 */
export const REFERENCE_ROLES = ["style", "script", "brand", "product"] as const;
export type ReferenceRole = (typeof REFERENCE_ROLES)[number];
/** Roles of references saved before roles existed, from their single type. */
const LEGACY_REFERENCE_ROLES: Record<string, ReferenceRole[]> = { reference: ["style"], "design-system": ["brand"], planner: ["script"], ui: ["product"], "product-launch": ["product"] };
export const referenceSchema = z.preprocess(
  (raw) => {
    if (!raw || typeof raw !== "object" || "roles" in raw) return raw;
    const { type, ...rest } = raw as { type?: string };
    return { ...rest, roles: LEGACY_REFERENCE_ROLES[type ?? ""] ?? ["style"] };
  },
  z.object({
    id, title: z.string().min(1).max(160), roles: z.array(z.enum(REFERENCE_ROLES)).min(1).max(REFERENCE_ROLES.length),
    content: z.string().max(16000), url: z.union([z.literal(""), z.url().refine((v) => /^https?:\/\//.test(v))]),
    /** The uploaded file this reference is (a video, image or document): guidance only, never material for the cut. */
    assetId: id.optional(),
    analysis: referenceAnalysisSchema.optional(),
  }),
);
export type EditReference = z.infer<typeof referenceSchema>;
export const editDocumentSchema = z.object({
  enabled: z.boolean().default(false), revision: z.number().int().nonnegative().default(0),
  duration: z.number().finite().min(0.1).max(7200).default(15),
  background: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#101018"),
  direction: videoDirectionSchema.optional(),
  assets: z.array(assetSchema).max(100).default([]), clips: z.array(editClipSchema).max(500).default([]),
  overlays: z.array(overlaySchema).max(3000).default([]), references: z.array(referenceSchema).max(40).default([]),
  /** Names and terms to correct in subtitles, and cuts proposed from the transcript (see transcript-schema.ts). */
  transcript: transcriptStateSchema.optional(),
}).superRefine((doc, ctx) => {
  const ids = new Set<string>();
  for (const item of [...doc.assets, ...doc.clips, ...doc.overlays, ...doc.references]) {
    if (ids.has(item.id)) ctx.addIssue({ code: "custom", message: "Hay identificadores duplicados." });
    ids.add(item.id);
  }
  const referenceAssets = referenceAssetIds(doc);
  for (const reference of doc.references) {
    if (reference.assetId && !doc.assets.some((a) => a.id === reference.assetId)) ctx.addIssue({ code: "custom", message: translate("The reference \"{0}\" points to a file that does not exist.", reference.title) });
  }
  for (const clip of doc.clips) {
    const asset = doc.assets.find((a) => a.id === clip.assetId);
    if (!asset || asset.kind === "document") ctx.addIssue({ code: "custom", message: translate("Choose a media file from this project for the clip.") });
    if (asset && referenceAssets.has(asset.id)) ctx.addIssue({ code: "custom", message: translate("\"{0}\" is a reference: it guides the style or the script, but it does not enter the assembly. Remove References if you want to use it as material.", asset.name) });
    if (asset && asset.kind !== "image" && clip.in + sourceSpan(clip) > asset.duration + 0.05)
      ctx.addIssue({ code: "custom", message: translate("The cut exceeds the duration of {0}.", asset.name) });
  }
  for (const item of [...doc.clips, ...doc.overlays]) {
    if (item.start + item.duration > 7200) ctx.addIssue({ code: "custom", message: translate("The edit exceeds two hours.") });
  }
});
export type EditDocument = z.infer<typeof editDocumentSchema>;
export type EditAsset = z.infer<typeof assetSchema>;
export type EditClip = z.infer<typeof editClipSchema>;
export type EditOverlay = z.infer<typeof overlaySchema>;
/** A clip's speed; clips saved before speed existed play at 1. */
export const clipSpeed = (clip: { speed?: number }) => clip.speed ?? 1;
/** How many seconds of the source file a clip uses. */
export const sourceSpan = (clip: { duration: number; speed?: number }) => clip.duration * clipSpeed(clip);
export const emptyEditDocument = (): EditDocument => editDocumentSchema.parse({});
export const editDuration = (d: EditDocument) => Math.max(d.duration, ...[...d.clips, ...d.overlays].map((x) => x.start + x.duration));
/** Narration files (a voice-over, the voice of a script's scenes) are named like this: it is what tells a voice from music. */
export const VOICEOVER_PREFIX = "Voiceover ";
export const isNarrationName = (name: string) => name.startsWith(VOICEOVER_PREFIX) || name.startsWith("Locución ");
/** Ids of the files that are references (guidance for the assistant, not material for the cut). */
export const referenceAssetIds = (d: Pick<EditDocument, "references">) => new Set(d.references.flatMap((r) => (r.assetId ? [r.assetId] : [])));
export const assetUrl = (a: EditAsset) => `/api/files/${a.path.split("/").map(encodeURIComponent).join("/")}`;

export function newOverlay(text: string, start = 0, duration = 5, kind: EditOverlay["kind"] = "text"): EditOverlay {
  return { id: crypto.randomUUID(), text, start, duration, kind, x: 10, y: kind === "caption" ? 75 : 35, width: 80,
    fontSize: kind === "caption" ? 48 : 72, color: "#ffffff", background: "#101018", align: "center" };
}

/** Splits preserve source offsets, volume and frame fitting. */
export function splitClip(clip: EditClip, at: number): EditClip[] {
  const offset = at - clip.start;
  if (offset < 0.04 || clip.duration - offset < 0.04) return [clip];
  return [{ ...clip, duration: offset }, { ...clip, id: crypto.randomUUID(), start: at, in: clip.in + offset * clipSpeed(clip), duration: clip.duration - offset, transition: "cut" }];
}

export function parseSubtitles(input: string): EditOverlay[] {
  const time = (s: string) => s.replace(",", ".").split(":").reduce((a, n) => a * 60 + Number(n), 0);
  const cues: EditOverlay[] = [];
  for (const block of input.replace(/^\uFEFF/, "").replace(/\r/g, "").split(/\n\s*\n/)) {
    const lines = block.split("\n");
    const index = lines.findIndex((l) => l.includes("-->"));
    if (index < 0) continue;
    const match = lines[index].match(/((?:\d{2}:)?\d{2}:\d{2}[,.]\d{3})\s*-->\s*((?:\d{2}:)?\d{2}:\d{2}[,.]\d{3})/);
    if (!match) continue;
    const start = time(match[1]), end = time(match[2]);
    const text = lines.slice(index + 1).join("\n").replace(/<[^>]*>/g, "").trim();
    if (text && end > start) cues.push(newOverlay(text, start, end - start, "caption"));
  }
  if (!cues.length) throw new Error(translate("There are no valid subtitles. Use a SRT or VTT file with time."));
  return cues;
}

/** Shortest subtitle worth showing (s); the schema's floor is 0.04. */
export const MIN_CAPTION = 0.1;

/**
 * Source-time captions follow trims, duplicated clips and removed silences.
 * A phrase that crosses a cut comes out as one caption when its pieces are
 * back to back on the timeline and in order in the source (the silence in
 * between was removed); a duplicated clip still repeats its text.
 */
export function captionsForClips(cues: EditOverlay[], clips: EditClip[]): EditOverlay[] {
  const ordered = [...clips].sort((a, b) => a.start - b.start);
  return cues.flatMap((cue) => {
    const pieces: { overlay: EditOverlay; sourceEnd: number }[] = [];
    for (const clip of ordered) {
      const speed = clipSpeed(clip);
      const from = Math.max(cue.start, clip.in), to = Math.min(cue.start + cue.duration, clip.in + sourceSpan(clip));
      // A sliver of a phrase (a cut right at its edge) would flash for a frame and is below what a subtitle may last.
      if ((to - from) / speed < MIN_CAPTION) continue;
      const start = clip.start + (from - clip.in) / speed;
      const last = pieces.at(-1);
      const sourceFrom = from;
      if (last && Math.abs(start - (last.overlay.start + last.overlay.duration)) <= 0.05 && sourceFrom >= last.sourceEnd - 0.001) {
        last.overlay = { ...last.overlay, duration: start + (to - from) / speed - last.overlay.start };
        last.sourceEnd = to;
      } else pieces.push({ overlay: { ...cue, id: crypto.randomUUID(), start, duration: (to - from) / speed }, sourceEnd: to });
    }
    return pieces.map((p) => p.overlay);
  }).sort((a, b) => a.start - b.start);
}

/** Silence kept on each side of a cut so words keep their attack and decay (a hard cut at the detector's threshold clips them). */
export const SILENCE_PAD = 0.1;
/** Shortest stretch of silence worth cutting once the padding is accounted for. */
const MIN_CUT = 0.15;

/**
 * Stretches of a source trim to keep after cutting silences found by
 * ffmpeg's silencedetect. `pad` leaves that much silence next to speech; a
 * silence that is not at least `2 * pad + 0.15` s long is left alone. A silence
 * touching the edge of the trim is cut flush on that side.
 */
export function keptRanges(log: string, from: number, duration: number, pad = SILENCE_PAD): { in: number; duration: number }[] {
  const end = from + duration;
  let cursor = from;
  const kept: { in: number; duration: number }[] = [];
  const silences = [...log.matchAll(/silence_(start|end):\s*([\d.]+)/g)];
  let silenceStart = 0;
  for (const m of silences) {
    if (m[1] === "start") silenceStart = Number(m[2]);
    else {
      const edgeA = Math.max(from, silenceStart), edgeB = Math.min(end, Number(m[2]));
      if (edgeB <= edgeA) continue;
      const a = edgeA > from ? edgeA + pad : edgeA, b = edgeB < end ? edgeB - pad : edgeB;
      if (b - a < (pad > 0 ? MIN_CUT : 0)) continue;
      if (a - cursor >= 0.08) kept.push({ in: cursor, duration: a - cursor });
      cursor = Math.max(cursor, b);
    }
  }
  if (end - cursor >= 0.08) kept.push({ in: cursor, duration: end - cursor });
  return kept;
}

/** Ripple deletion applies to every track so replacement audio and captions stay in sync. */
export function rippleSilences(doc: EditDocument, selected: EditClip, sourceRanges: { in: number; duration: number }[]): EditDocument {
  if (clipSpeed(selected) !== 1) throw new Error("Pon el clip a velocidad 1× antes de cortar sus silencios.");
  const end = selected.start + selected.duration;
  const intervals = [{ start: 0, end: selected.start }, ...sourceRanges.map((r) => ({ start: selected.start + r.in - selected.in, end: selected.start + r.in - selected.in + r.duration })), { start: end, end: 7200 }].filter((r) => r.end - r.start >= 0.001);
  const removed = selected.duration - sourceRanges.reduce((sum, r) => sum + r.duration, 0);
  if (removed < 0.001) return { ...doc, enabled: true };
  // Both edges of every piece come from the same function of the same instant, on the 30 fps frame grid
  // of the export: neighbours share an edge exactly, so nothing overlaps (a stray second lane) or leaves a gap (a flicker).
  const frame = (t: number) => Math.round(t * 30) / 30;
  const mapTime = (t: number) => {
    let result = 0;
    for (const r of intervals) result += Math.max(0, Math.min(t, r.end) - r.start);
    return frame(result);
  };
  const clips = doc.clips.flatMap((c) => intervals.flatMap((r) => {
    const from = Math.max(c.start, r.start), to = Math.min(c.start + c.duration, r.end);
    if (to - from < 0.04) return [];
    const start = mapTime(from), finish = mapTime(to);
    if (finish - start < 0.03) return [];
    // Only the first piece of a clip arrives with its transition: the rest are jump cuts inside one shot.
    return [{ ...c, id: crypto.randomUUID(), start, duration: finish - start, in: Math.round((c.in + (from - c.start) * clipSpeed(c)) * 1000) / 1000, transition: from > c.start + 0.001 ? "cut" as const : c.transition }];
  }));
  const overlays = doc.overlays.flatMap((o) => {
    const start = mapTime(o.start), finish = mapTime(o.start + o.duration);
    return finish - start >= 0.03 ? [{ ...o, start, duration: finish - start }] : [];
  });
  return { ...doc, enabled: true, duration: Math.max(0.1, Math.round((doc.duration - removed) * 1000) / 1000), clips, overlays };
}

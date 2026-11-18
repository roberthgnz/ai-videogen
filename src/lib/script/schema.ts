import { t as translate } from "@/lib/i18n";
import { z } from "zod";
import { TEMPLATE_IDS } from "../domain";
import { bulletsContentSchema } from "@/templates/bullets";
import { introContentSchema } from "@/templates/intro";
import { outroContentSchema } from "@/templates/outro";
import { textContentSchema } from "@/templates/text";
import { contentIssues } from "@/templates/registry";
import { theme } from "@/theme";

/**
 * Spoken Spanish pace of a TTS voice before its real pace is known (projects.voicePace measures it).
 * Measured on generated narration: from 2.3 w/s (a slow narrator) to 2.8 (a quick one).
 */
export const WORDS_PER_SECOND = 2.5;

export const MIN_SCENES = 3;
export const MAX_SCENES = 12;
export const MAX_NARRATION_CHARS = 600;
export const MAX_TITLE_CHARS = 80;

export const MIN_VISUAL_QUERIES = 2;
export const MAX_VISUAL_QUERIES = 3;
export const MAX_VISUAL_QUERY_CHARS = 60;

const narration = z.string().min(1).max(MAX_NARRATION_CHARS);
/** English stock-footage searches for the scene's b-roll. */
export const visualQueriesSchema = z
  .array(z.string().min(2).max(MAX_VISUAL_QUERY_CHARS))
  .min(MIN_VISUAL_QUERIES)
  .max(MAX_VISUAL_QUERIES);
const visuals = visualQueriesSchema;

/** One scene as the LLM returns it. `content` shape depends on `template`. */
export const sceneDraftSchema = z.discriminatedUnion("template", [
  z.object({ template: z.literal("intro"), narration, visuals, content: introContentSchema }),
  z.object({ template: z.literal("text"), narration, visuals, content: textContentSchema }),
  z.object({ template: z.literal("bullets"), narration, visuals, content: bulletsContentSchema }),
  z.object({ template: z.literal("outro"), narration, visuals, content: outroContentSchema }),
]);

/** What the script generator returns. Also the structured-output schema sent to the LLM. */
export const scriptDraftSchema = z.object({
  title: z.string().min(1).max(MAX_TITLE_CHARS),
  scenes: z.array(sceneDraftSchema).min(MIN_SCENES).max(MAX_SCENES),
});

export type SceneDraft = z.infer<typeof sceneDraftSchema>;
export type ScriptDraft = z.infer<typeof scriptDraftSchema>;

/** Structural rules the schema alone can't express. Returns Spanish issues or []. */
export function scriptRuleIssues(draft: Pick<ScriptDraft, "scenes">): string[] {
  const issues: string[] = [];
  const { scenes } = draft;
  if (scenes.length === 0) return [translate("The script has no scenes.")];
  if (scenes[0].template !== "intro") issues.push(translate("The first scene must use the intro template."));
  if (scenes[scenes.length - 1].template !== "outro") {
    issues.push(translate("The last scene must use the outro template."));
  }
  scenes.forEach((scene, i) => {
    if (scene.template === "intro" && i !== 0) issues.push(translate("Scene {0}: intro can only go to the beginning.", i + 1));
    if (scene.template === "outro" && i !== scenes.length - 1) {
      issues.push(translate("Scene {0}: outro can only go to the end.", i + 1));
    }
  });
  return issues;
}

/** A scene as edited in the UI. `id` is absent for scenes not yet saved. */
export const editableSceneSchema = z.object({
  id: z.string().optional(),
  template: z.enum(TEMPLATE_IDS),
  narration: z.string().max(MAX_NARRATION_CHARS),
  content: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
  /** B-roll searches; may be empty (they are generated when the b-roll is searched). */
  visualQueries: z.array(z.string().max(MAX_VISUAL_QUERY_CHARS)).max(MAX_VISUAL_QUERIES + 1).default([]),
});

export const editableScriptSchema = z.object({
  title: z.string().max(MAX_TITLE_CHARS),
  scenes: z.array(editableSceneSchema).max(MAX_SCENES),
});

// Input types: `visualQueries` may be omitted (it defaults to none).
export type EditableScene = z.input<typeof editableSceneSchema>;
export type EditableScript = z.input<typeof editableScriptSchema>;

/** Per-scene validation for a script edited in the UI. Key = scene index. */
export function editableScriptIssues(script: EditableScript): Record<number, string[]> {
  const out: Record<number, string[]> = {};
  script.scenes.forEach((scene, i) => {
    const issues = contentIssues(scene.template, scene.content);
    if (!scene.narration.trim()) issues.unshift(translate("Narration: cannot be empty"));
    if (issues.length) out[i] = issues;
  });
  return out;
}

export function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

/** Rough spoken duration before real TTS exists. */
export function estimateSeconds(text: string): number {
  return countWords(text) / WORDS_PER_SECOND;
}

/**
 * Narration word budget and a sensible scene count for a target duration. The composition adds a short
 * silence around each scene's narration (theme.timing), so that time is not spent on words.
 */
export function scriptBudget(targetDurationSec: number, wordsPerSecond = WORDS_PER_SECOND) {
  const scenes = Math.min(10, Math.max(MIN_SCENES + 1, Math.round(targetDurationSec / 7)));
  const speech = Math.max(targetDurationSec * 0.7, targetDurationSec - scenes * (theme.timing.sceneLead + theme.timing.sceneTail));
  const words = Math.round(speech * wordsPerSecond);
  return { words, scenes };
}

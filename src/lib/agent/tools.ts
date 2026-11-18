import { t as translate, getLocale } from "@/lib/i18n";
import { z } from "zod";
import { saveEditDocument } from "@/lib/editing/repository";
import { videoDirectionSchema, captionAppearanceSchema, referenceAnalysisSchema, editClipSchema, overlaySchema, newOverlay, editDuration, captionsForClips, keptRanges, rippleSilences, referenceAssetIds, type EditAsset } from "@/lib/editing/schema";
import { studyReference } from "@/lib/editing/reference-study";
import { analyzeMedia } from "@/lib/editing/media";
import { addVoiceover } from "@/lib/editing/voiceover";
import { cutFilmstrip, filmstrip, footageLog } from "@/lib/editing/footage";
import { textPreview, textReadability, textWarnings } from "@/lib/editing/text-preview";
import { applyEditNotes, accumulateNoteReview, describeNoteChanges, editNotesSchema, NOTE_REVIEW_PAGE_SIZE, pendingNotePages, type NoteReview } from "@/lib/editing/notes";
import { notePreviewPage, noteWarnings } from "@/lib/editing/note-preview";
import { readNoteReview, saveNoteReview } from "@/lib/editing/note-review";
import { brollLegend, brollSheet } from "@/lib/editing/broll-sheet";
import { resolveStoryboard } from "@/lib/editing/footage-plan";
import { resolveInStorage } from "@/lib/storage";
import { getTtsProvider } from "@/lib/pipeline/tts";
import { isNarration, syncMusic } from "@/lib/editing/music";
import { buildScriptTimeline, hasScriptTimeline } from "@/lib/editing/script-timeline";
import { arrangeClips } from "@/lib/editing/arrange";
import { assetOverviews } from "@/lib/editing/overview";
import { applyClipEffects, CLIP_TRANSITIONS, EFFECT_MOTIONS } from "@/lib/editing/effects";
import { montageCaptions } from "@/lib/editing/transcript";
import { TRANSCRIPT_TOOLS } from "./transcript-tools";
import {
  CAPTION_STYLES,
  TEMPLATE_IDS,
  TRANSITIONS,
  VIDEO_FORMATS,
  type AgentSuggestion,
  type TemplateId,
} from "@/lib/domain";
import { listMusic, listSfx, MUSIC_AUTO, MUSIC_NONE } from "@/lib/pipeline/audio/music";
import { runScriptStep } from "@/lib/pipeline/steps/script";
import { startTtsForProject, isTtsActive } from "@/lib/pipeline/steps/tts";
import { cancelVideo, isRenderActive, startVideo } from "@/lib/pipeline/steps/video";
import { candidateKey, pickShot, runVisualsForProject, searchShot } from "@/lib/pipeline/steps/visuals";
import {
  defaultVoiceId,
  getProject,
  MAX_TITLE_CHARS,
  projectSettingsSchema,
  renameProject,
  saveScript,
  updateProjectSettings,
  type ProjectSettings,
  type ProjectWithRelations,
} from "@/lib/projects";
import {
  editableScriptIssues,
  MAX_SCENES,
  MAX_VISUAL_QUERIES,
  MAX_VISUAL_QUERY_CHARS,
  type EditableScript,
} from "@/lib/script/schema";
import { PRESET_IDS, STYLE_PRESETS } from "@/presets";
import { convertContent, emptyContent } from "@/templates/registry";
import { describeStyleForAgent, STYLE_TOOLS } from "@/lib/style-profile/agent";
import { PASS_TOOLS } from "./pass-tools";
import { GRAPHIC_TOOLS } from "./graphic-tools";
import { COMPOSITION_TOOLS } from "./composition-tools";
import { isGraphic } from "@/lib/editing/graphics";
import { describePasses } from "@/lib/editing/passes";

/** What a tool may call. Injected in tests so nothing paid or slow runs. */
export interface AgentDeps {
  runScript: typeof runScriptStep;
  runVisuals: typeof runVisualsForProject;
  searchShot: typeof searchShot;
  startVideo: typeof startVideo;
  startTts: typeof startTtsForProject;
  addVoiceover: typeof addVoiceover;
  buildTimeline: typeof buildScriptTimeline;
  /** The provider's voices, to pick one when the project has none. */
  listVoices: () => Promise<{ id: string; name: string; category?: string; labels?: Record<string, string>; description?: string | null }[]>;
}

export const defaultDeps: AgentDeps = {
  runScript: runScriptStep,
  runVisuals: runVisualsForProject,
  searchShot,
  startVideo,
  startTts: startTtsForProject,
  addVoiceover,
  buildTimeline: buildScriptTimeline,
  listVoices: () => getTtsProvider().listVoices(),
};

export interface AgentContext {
  projectId: string;
  deps: AgentDeps;
  /** Next steps the agent proposed this turn (see `propose_actions`). */
  suggestions: AgentSuggestion[];
  /** What the agent told the user this turn: the `message` of `propose_actions`. */
  message?: string | null;
  /**
   * Pictures a tool wants the model to see with its result (base64 JPEG): the cut it just made, a stretch of
   * footage. The runner sends them with the tool's text and empties the list; runners without images ignore them.
   */
  images?: string[];
  /** Scoped changes and the review coverage of this note; also checkpointed independently of the montage. */
  noteReview?: NoteReview;
  signal?: AbortSignal;
  editingOperations?: Set<symbol>;
}

export interface AgentTool<S extends z.ZodObject = z.ZodObject> {
  name: string;
  description: string;
  schema: S;
  /** Short description shown in the action chip. */
  label: (input: z.infer<S>) => string;
  /** Does the work and returns what the model should read afterwards. Throws a readable Error to refuse. */
  run: (input: z.infer<S>, ctx: AgentContext) => Promise<string> | string;
}

function tool<S extends z.ZodObject>(def: AgentTool<S>): AgentTool<S> {
  return { ...def, run: (input, ctx) => {
    // Once a note uses ID patches, don't let a later call rebuild the montage and undo that protection.
    const review = currentNoteReview(ctx);
    if (review && NOTE_REBUILD_TOOLS.has(def.name)) {
      throw new Error(translate("This note is in a retouching mode: use apply_edit_notes by identifier and field. Do not rebuild, resynchronize or replace the assembly to correct it."));
    }
    if (review && def.name === "generate_video" && (review.revision !== project(ctx).edit.revision || pendingNotePages(review).length)) {
      throw new Error(translate("The note needs to be reviewed in the current review before export. Use review_edit_notes for all outstanding lots."));
    }
    if (def.name === "apply_edit_notes" && ctx.editingOperations?.size) throw new Error(translate("There is another editing tool in progress. Wait for its result and read the current status before applying the note; do not run dependent changes in parallel."));
    if (!NOTE_REBUILD_TOOLS.has(def.name)) return def.run(input, ctx);
    const operation = Symbol(def.name);
    const operations = ctx.editingOperations ??= new Set<symbol>();
    operations.add(operation);
    try {
      const result = def.run(input, ctx);
      if (typeof result === "string") { operations.delete(operation); return result; }
      return result.finally(() => { operations.delete(operation); });
    } catch (error) {
      operations.delete(operation);
      throw error;
    }
  } };
}

const NOTE_REBUILD_TOOLS = new Set(["edit_workspace", "place_text", "build_edit", "build_timeline", "arrange_clips", "sync_music_to_beats", "set_clip_effects", "set_style", "write_script", "edit_scene", "add_scene", "remove_scene", "move_scene", "add_voiceover", "generate_voice", "find_broll", "change_shot", "next_clip", "analyze_media"]);

function currentNoteReview(ctx: AgentContext): NoteReview | undefined {
  // An unfinished note is resumed explicitly by its tools, never by an unrelated question or new montage.
  return ctx.noteReview;
}

/** A runner that hits its limit must report the pending review instead of claiming the note is finished. */
export function noteReviewOutcome(ctx: AgentContext): string | undefined {
  const review = currentNoteReview(ctx);
  if (!review) return undefined;
  if (review.revision !== project(ctx).edit.revision) {
    ctx.suggestions = [{ label: translate("Review current version"), tool: "review_edit_notes", input: { expectedRevision: project(ctx).edit.revision, page: 0 } }];
    return translate("The note changes are saved, but the assembly has changed during the review. It is necessary to review the current version before it is completed.");
  }
  const pending = pendingNotePages(review);
  if (pending.length) {
    ctx.suggestions = [{ label: translate("Continue review"), tool: "review_edit_notes", input: { expectedRevision: review.revision, page: pending[0] } }];
    return translate("The note changes are saved. {0} lots of times affected to review remain; you can continue from here without repeating the changes.", pending.length);
  }
  if (review.unavailable.size) {
    ctx.suggestions = [{ label: translate("Retry review"), tool: "review_edit_notes", input: { expectedRevision: review.revision, page: [...review.unavailable][0] } }];
    return translate("The note changes are saved, but not all the necessary images could be obtained. The visual review is incomplete; I cannot confirm that all the moments are correct.");
  }
  return undefined;
}

// ---------------------------------------------------------------- helpers

function project(ctx: AgentContext): ProjectWithRelations {
  const found = getProject(ctx.projectId);
  if (!found) throw new Error(translate("The project no longer exists."));
  return found;
}

function sceneAt(p: ProjectWithRelations, n: number) {
  const scene = p.scenes[n - 1];
  if (!scene) throw new Error(p.scenes.length === 0 ? translate("The project still has no scenes.") : translate("The scene {0} does not exist (there is {1}).", n, p.scenes.length));
  return scene;
}

/**
 * The voice for a generation, never a dead end: the project's, else the default (Ajustes, configured or last
 * used), else the voice matching the app language. A voice chosen here is saved on the project and reported, so
 * the user can change it.
 */
async function ensureVoice(ctx: AgentContext): Promise<{ voiceId: string; chosen: string | null }> {
  const p = project(ctx);
  if (p.voiceId) return { voiceId: p.voiceId, chosen: null };
  let voiceId = defaultVoiceId();
  let name: string | null = null;
  if (!voiceId) {
    const voices = await ctx.deps.listVoices().catch((error) => { throw new Error(translate("There is no chosen voice and the list of voices could not be consulted: {0}", error instanceof Error ? error.message : error)); });
    const text = (v: (typeof voices)[number]) => `${v.name} ${v.description ?? ""} ${Object.values(v.labels ?? {}).join(" ")}`;
    // The public list mixes narrators with characters and solemn readers: lean to a clear, friendly voice
    // that suits short social videos (the person can change it in Guion › Voz y estilo).
    // The person's own voices («Mis voces») come first; then the friendliest of the popular ones.
    const fit = (v: (typeof voices)[number]) =>
      (v.category === "Mis voces" ? 5 : 0)
      + (/friendly|amigabl|cercan|natural|clear|clara|social|redes|tutorial|conversational|warm|cálid/i.test(text(v)) ? 2 : 0)
      - (/b[ií]blic|spiritual|espiritual|terror|horror|demon|circo|circus|anime|parod|meme|brainrot|cartoon|dibujo|loquendo|goku|simpson|pony|miku|teto/i.test(text(v)) ? 3 : 0);
    const language = getLocale() === "es"
      ? /(^|[^a-z])es([^a-z]|$)|español|spanish|castellano/i
      : /(^|[^a-z])en([^a-z]|$)|english|inglés/i;
    const matching = voices
      .map((v, i) => ({ v, i }))
      .filter(({ v }) => language.test(text(v)))
      .sort((a, b) => fit(b.v) - fit(a.v) || a.i - b.i)[0]?.v;
    const pick = matching ?? voices[0];
    if (!pick) throw new Error(translate("There is no voice available in the voice provider."));
    voiceId = pick.id; name = pick.name;
  }
  updateProjectSettings(p.id, { ...settingsOf(p), voiceId });
  return { voiceId, chosen: name ?? translate("the default voice") };
}
// Shown as is in the chat when a button runs the tool, so it speaks to the person, not about them.
const voiceNote = (chosen: string | null) => chosen ? translate(" Since there was no chosen voice, I used {0}; you can change it in the script › Voice and style.", chosen.startsWith("la ") ? chosen : `«${chosen}»`) : "";

function settingsOf(p: ProjectWithRelations): ProjectSettings {
  return projectSettingsSchema.parse({
    topic: p.topic,
    targetDurationSec: p.targetDurationSec,
    tone: p.tone,
    format: p.format,
    voiceId: p.voiceId,
    preset: p.preset,
    captionStyle: p.captionStyle,
    transition: p.transition,
    music: p.music,
    sfx: p.sfx,
  });
}

function scriptOf(p: ProjectWithRelations): EditableScript {
  return {
    title: p.title,
    scenes: p.scenes.map((s) => ({
      id: s.id,
      template: s.template,
      narration: s.narration,
      content: s.content,
      visualQueries: s.visualQueries,
    })),
  };
}

/** Saves a script after the same validation the editor applies. */
function saveChecked(projectId: string, script: EditableScript) {
  const issues = editableScriptIssues(script);
  const first = Object.entries(issues)[0];
  if (first) throw new Error(translate("Scene {0}: {1}", Number(first[0]) + 1, first[1].join("; ")));
  saveScript(projectId, script);
}

const clip = (text: string, max = 70) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

function summarizeScenes(p: ProjectWithRelations): string {
  return p.scenes.map((s, i) => `${i + 1}. [${s.template}] ${clip(s.narration)}`).join("\n");
}

const sceneNumber = z.number().int().min(1).describe("Scenario number, starting at 1");
const visualQueries = z
  .array(z.string().min(2).max(MAX_VISUAL_QUERY_CHARS))
  .max(MAX_VISUAL_QUERIES)
  .describe(`English stock video search (2-4 words each, max. ${MAX_VISUAL_QUERIES}), one plane per search`);
const contentPatch = z
  .record(z.string(), z.union([z.string(), z.array(z.string())]))
  .describe(
    "Field-screen text: intro {title, subtitle}, text {headline, body}, bullets {heading, items []}, outro {headline and cta}.",
  );

// ---------------------------------------------------------------- tools

const writeScript = tool({
  name: "write_script",
  description:
    "Write the full video script (scenes with narration, on-screen text and b-roll searches). REPLACE all current scenes: use it only if there is no script or if you are asked to redo it from scratch. It takes a few seconds.",
  schema: z.object({
    topic: z.string().max(2000).optional().describe("Video theme; if missing the project theme is used"),
    duration_sec: z.number().int().min(10).max(180).optional().describe("Target duration in seconds"),
    tone: z.string().max(60).optional().describe("Tone, e.g. informative, fun, energetic"),
    direction: videoDirectionSchema.optional().describe("Resources decided according to the prompt and the reference before writing; not all script is narrated"),
  }),
  label: (i) => (i.topic ? translate("Write the script: {0}", clip(i.topic, 50)) : translate("Write the script")),
  run: async (input, ctx) => {
    const p = project(ctx);
    const next = {
      ...settingsOf(p),
      topic: input.topic?.trim() || p.topic,
      targetDurationSec: input.duration_sec ?? p.targetDurationSec,
      tone: input.tone?.trim() || p.tone,
    };
    if (!next.topic.trim()) throw new Error(translate("The video is missing."));
    if (input.direction) saveEditDocument(p.id, { ...p.edit, direction: input.direction });
    updateProjectSettings(ctx.projectId, next);
    const result = await ctx.deps.runScript(ctx.projectId);
    if (!result.ok) throw new Error(result.error);
    const written = project(ctx);
    return translate("Written script, {0} scenes:\n{1}", written.scenes.length, summarizeScenes(written));
  },
});

const editScene = tool({
  name: "edit_scene",
  description:
    "It changes a scene: its narrative (what the voice says; the audio regenerates itself), its template, its on-screen text or its b-roll searches. It only happens what changes.",
  schema: z.object({
    scene: sceneNumber,
    narration: z.string().min(1).optional(),
    template: z.enum(TEMPLATE_IDS).optional().describe("intro solo al principio, outro solo al final"),
    content: contentPatch.optional(),
    visual_queries: visualQueries.optional(),
  }),
  label: (i) => translate("Edit the scene {0}", i.scene),
  run: (input, ctx) => {
    const p = project(ctx);
    const scene = sceneAt(p, input.scene);
    const script = scriptOf(p);
    const draft = script.scenes[input.scene - 1];
    if (input.template && input.template !== draft.template) {
      draft.content = convertContent(draft.template, draft.content, input.template);
      draft.template = input.template;
    }
    if (input.content) draft.content = { ...draft.content, ...input.content };
    if (input.narration) draft.narration = input.narration;
    if (input.visual_queries) draft.visualQueries = input.visual_queries;
    saveChecked(ctx.projectId, script);
    const changed = [
      input.narration && translate("narration"),
      input.template && `plantilla ${input.template}`,
      input.content && translate("on-screen text"),
      input.visual_queries && translate("b-roll searches"),
    ].filter(Boolean);
    return translate("{0} ({1}] scene updated: {2}.", input.scene, scene.id.slice(0, 4), changed.join(", ") || translate("No change"));
  },
});

const addScene = tool({
  name: "add_scene",
  description: "Add a new scene after the indicated scene (0 = at the beginning).",
  schema: z.object({
    after: z.number().int().min(0).describe("Scene behind which it goes; 0 = the first"),
    narration: z.string().min(1),
    template: z.enum(TEMPLATE_IDS).optional().describe("Por defecto text"),
    content: contentPatch.optional(),
    visual_queries: visualQueries.optional(),
  }),
  label: (i) => translate("Add a scene {0}", i.after === 0 ? " al principio" : ` tras la ${i.after}`),
  run: (input, ctx) => {
    const p = project(ctx);
    if (p.scenes.length >= MAX_SCENES) throw new Error(translate("There are already {0} scenes, maximum.", MAX_SCENES));
    if (input.after > p.scenes.length) throw new Error(translate("There are only {0} scenes.", p.scenes.length));
    const template: TemplateId = input.template ?? "text";
    const script = scriptOf(p);
    script.scenes.splice(input.after, 0, {
      template,
      narration: input.narration,
      content: { ...emptyContent(template), ...(input.content ?? {}) },
      visualQueries: input.visual_queries ?? [],
    });
    saveChecked(ctx.projectId, script);
    return translate("Scene added as number {0}. Now there is {1}.", input.after + 1, script.scenes.length);
  },
});

const removeScene = tool({
  name: "remove_scene",
  description: "Eliminate a scene.",
  schema: z.object({ scene: sceneNumber }),
  label: (i) => translate("Remove the scene {0}", i.scene),
  run: (input, ctx) => {
    const p = project(ctx);
    sceneAt(p, input.scene);
    const script = scriptOf(p);
    script.scenes.splice(input.scene - 1, 1);
    saveChecked(ctx.projectId, script);
    return translate("Scene {0} eliminated. {1}.", input.scene, script.scenes.length);
  },
});

const moveScene = tool({
  name: "move_scene",
  description: "Move a scene to another position.",
  schema: z.object({ scene: sceneNumber, to: sceneNumber.describe("Destination position, starting at 1") }),
  label: (i) => translate("Move the scene {0} to the position {1}", i.scene, i.to),
  run: (input, ctx) => {
    const p = project(ctx);
    sceneAt(p, input.scene);
    sceneAt(p, input.to);
    const script = scriptOf(p);
    const [moved] = script.scenes.splice(input.scene - 1, 1);
    script.scenes.splice(input.to - 1, 0, moved);
    saveChecked(ctx.projectId, script);
    return translate("Scene moved to position {0}.\n{1}", input.to, summarizeScenes(project(ctx)));
  },
});

const setStyle = tool({
  name: "set_style",
  description:
    "Change video settings. `preset` applies color, subtitles and transition (viral, clean, impact); the rest can be tuned apart. Music: self, none or a file name from the folder.",
  schema: z.object({
    preset: z.enum(PRESET_IDS).optional(),
    caption_style: z.enum(CAPTION_STYLES).optional().describe("pop = 1-3 giant words; line = phrase with the word highlighted; box = color box after the word"),
    transition: z.enum(TRANSITIONS).optional(),
    music: z.string().max(200).optional(),
    sfx: z.boolean().optional().describe("Sound effects on transitions"),
    format: z.enum(VIDEO_FORMATS).optional(),
    duration_sec: z.number().int().min(10).max(180).optional().describe("Target duration; only affects the next indent"),
    tone: z.string().max(60).optional().describe("Tono; only affects the next script"),
  }),
  label: (i) => {
    const parts = [
      i.preset && translate("style {0}", STYLE_PRESETS[i.preset].label),
      i.caption_style && translate("subtitles {0}", i.caption_style),
      i.transition && translate("transition {0}", i.transition),
      i.music && (i.music === MUSIC_NONE ? translate("without music") : i.music === MUSIC_AUTO ? translate("automatic music") : translate("music {0}", i.music)),
      i.sfx !== undefined && (i.sfx ? "con efectos" : translate("no effects")),
      i.format && (i.format === "vertical" ? "formato 9:16" : "formato 16:9"),
    ].filter(Boolean);
    return translate("Change: {0}", parts.join(", ") || "ajustes");
  },
  run: (input, ctx) => {
    const p = project(ctx);
    const next = settingsOf(p);
    if (input.preset) {
      const preset = STYLE_PRESETS[input.preset];
      next.preset = input.preset;
      next.captionStyle = preset.captionStyle;
      next.transition = preset.transition;
    }
    if (input.caption_style) next.captionStyle = input.caption_style;
    if (input.transition) next.transition = input.transition;
    if (input.sfx !== undefined) next.sfx = input.sfx;
    if (input.format) next.format = input.format;
    if (input.duration_sec) next.targetDurationSec = input.duration_sec;
    if (input.tone) next.tone = input.tone;
    if (input.music) {
      const library = listMusic();
      if (input.music !== MUSIC_AUTO && input.music !== MUSIC_NONE && !library.includes(input.music)) {
        throw new Error(
          library.length
            ? translate("There is no \"{0}\" track. Available: {1}.", input.music, library.join(", "))
            : translate("The storage/music folder is empty: no leads to choose from."),
        );
      }
      next.music = input.music;
    }
    updateProjectSettings(ctx.projectId, next);
    // A script already laid on the timeline keeps the look it was built with.
    const built = hasScriptTimeline(p.edit) ? translate(" The already mounted timeline does not change alone: to see it, you have to reassemble it (build_timeline), and that reacts the assembly and loses the handmade retouches.") : "";
    return translate("Sold settings: style {0}, subtitles {1}, transition {2}, {3}, music {4}, effects {5}. {6}", next.preset, next.captionStyle, next.transition, next.format, next.music, next.sfx ? translate("Yes") : "no", built);
  },
});

/**
 * The picked b-roll for the agent to look at: the sheet goes with the result, and the text says what each
 * scene's voice says, so a shot that shows something else (the sea for «agua hirviendo») gets replaced.
 */
async function showBroll(ctx: AgentContext, done: string): Promise<string> {
  const p = project(ctx);
  const sheet = await brollSheet(p);
  if (!sheet) return done;
  ctx.images = [...(ctx.images ?? []), sheet.image];
  return translate("{0}\nThe attached image shows the clip chosen in each plane (one row per scene; the number is scen.plane; a dark plane is a dark clip, not a hole: the gaps come out in red). What the voice says and what each plane sought:\n{1}\nLook at it as a fork: if a plane does not teach what the voice says at that time (the sea when it speaks of boiling water, another drink, a unrelated subject, text or water marks), change it with change_shot and a more concrete search (\"kettle pouring hot water\") or with next_clip, and look at it again before responding.", done, brollLegend(p, sheet.missing));
}

const findBroll = tool({
  name: "find_broll",
  description:
    "Search and choose stock video for the plans of all scenes (or one). By default only search for what is missing and respect what is chosen by hand; with refresh you search for the automatic plans. The stock is for filmed scenes: if the reference or the style requested is graphic (illustration, cuts, infography), or the scene is a data, a date, a map or a comparison, do not search for and divulge it with create_graphic.",
  schema: z.object({
    scene: sceneNumber.optional().describe("Just this scene; if it's missing, all of them"),
    refresh: z.boolean().optional().describe("Find the plans that already had clip again"),
  }),
  label: (i) => (i.scene ? translate("Find b-roll of the scene {0}", i.scene) : i.refresh ? translate("Go back to looking for the whole b-roll") : translate("Search b-roll")),
  run: async (input, ctx) => {
    const p = project(ctx);
    const target = input.scene ? sceneAt(p, input.scene) : null;
    const result = await ctx.deps.runVisuals(ctx.projectId, {
      refresh: input.refresh === true,
      sceneIds: target ? [target.id] : undefined,
    });
    if (!result.ok) throw new Error(result.error);
    if (result.skipped) throw new Error(translate("There is no b-roll supplier: missing PIXABAY_API_KEY in .env.loc."));
    return showBroll(ctx, translate("Done: {0} flat with chosen clip.", result.shots));
  },
});

const changeShot = tool({
  name: "change_shot",
  description: "Change the A plane clip of a scene looking for something else (search in English, 2-4 words). Choose the best result.",
  schema: z.object({
    scene: sceneNumber,
    shot: z.number().int().min(1).describe("Plane number inside the scene, starting at 1"),
    query: z.string().min(2).max(MAX_VISUAL_QUERY_CHARS).describe("What to look for, in English"),
  }),
  label: (i) => translate("Scene {0} plane {1}: {2}", i.shot, i.scene, clip(i.query, 40)),
  run: async (input, ctx) => {
    const scene = sceneAt(project(ctx), input.scene);
    const result = await ctx.deps.searchShot(scene.id, input.shot - 1, input.query);
    if (!result.ok) throw new Error(result.error);
    return showBroll(ctx, translate("{0} scale of the scene {1} changed to \"{2}\" ({3} alternatives).", input.shot, input.scene, result.shot.query, result.shot.candidates.length));
  },
});

const nextClip = tool({
  name: "next_clip",
  description: "It puts another different clip on a plane (the next best result of your own search). Use it to \"change that clip\" without changing the subject.",
  schema: z.object({ scene: sceneNumber, shot: z.number().int().min(1) }),
  label: (i) => translate("Another clip on the scene's plane {0} {1}", i.shot, i.scene),
  run: async (input, ctx) => {
    const p = project(ctx);
    const scene = sceneAt(p, input.scene);
    const shot = scene.shots?.[input.shot - 1];
    if (!shot || shot.candidates.length < 2) throw new Error(translate("That plane has no alternatives yet: it seeks b-roll first."));
    const used = new Set(p.scenes.flatMap((s) => (s.shots ?? []).flatMap((x) => (x.selected ? [candidateKey(x.selected)] : []))));
    const current = shot.selected ? candidateKey(shot.selected) : "";
    const start = Math.max(0, shot.candidates.findIndex((c) => candidateKey(c) === current));
    for (let step = 1; step <= shot.candidates.length; step++) {
      const candidate = shot.candidates[(start + step) % shot.candidates.length];
      if (used.has(candidateKey(candidate))) continue;
      const result = pickShot(scene.id, input.shot - 1, candidateKey(candidate));
      if (!result.ok) throw new Error(result.error);
      return showBroll(ctx, translate("The {0} plane of the scene {1} with another clip.", input.shot, input.scene));
    }
    throw new Error(translate("There are no unused alternatives left on that plane."));
  },
});

const generateVoice = tool({
  name: "generate_voice",
  description: "It generates the audio of scenes that do not have it up to date (it spends credit from the voice provider; the already generated is free).",
  schema: z.object({}),
  label: () => translate("Generate the voice"),
  run: async (_input, ctx) => {
    const { chosen } = await ensureVoice(ctx);
    const result = ctx.deps.startTts(ctx.projectId);
    if (!result.ok) throw new Error(result.error);
    return (result.queued === 0 ? translate("The whole audio was up to date.") : translate("Generating the voice of {0} scenes in the background.", result.queued)) + voiceNote(chosen);
  },
});

const buildTimeline = tool({
  name: "build_timeline",
  description:
    "Monta el guion visual en la LÍNEA DE TIEMPO sin renderizar. Decide explícitamente voiceover, captions, titles, music y sfx según el PROMPT; usa la referencia para lo no especificado y, si no hay evidencia, no añadas recursos por costumbre. Con voiceover=false monta las imágenes con la duración objetivo sin generar ni cobrar voz. La voz no implica subtítulos. Con voiceover=true puede gastar crédito de voz. Con stock=false no busca ni coloca vídeo de stock: deja la pista de imagen libre y te devuelve el tramo de cada escena para que la dibujes con create_graphic (úsalo cuando la referencia o el estilo pedido sea gráfico). SUSTITUYE clips y textos; conserva archivos y referencias. El usuario puede reproducir, retocar y exportar después.",
  schema: videoDirectionSchema.extend({ stock: z.boolean().optional().describe("Fasse = without stock video: the image will be own graphics (create_graphic) in the section of each scene. By default true") }),
  label: (i) => i.stock === false ? translate("Mounting the timeline (image with own graphics)") : translate("Build the timeline"),
  run: async (input, ctx) => {
    if (!project(ctx).scenes.length) throw new Error(translate("There is no script yet: write it first (write_script) and then write it down."));
    if (input.captions && !input.voiceover) throw new Error(translate("This visual script has no spoken audio to transcribe. For imported original voice subholder uses analyze_media; do not generate locution only to have subtitles."));
    const chosen = input.voiceover ? (await ensureVoice(ctx)).chosen : null;
    const { stock, ...direction } = input;
    const result = await ctx.deps.buildTimeline(ctx.projectId, { direction, stock });
    const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
    // One line: the chat shows a button's result by its first line.
    const summary = translate("Time line mounted: {0} s with {1}, {2}, {3}, {4} and {5}, every thing on your track. Give it to play to see it; you can move, cut or change whatever you want and export when you like (nothing has been rendezvous).{6}{7}", result.duration.toFixed(1), count(result.shots, translate("video plan"), translate("video plans")), count(result.voices, "voz", "voces"), count(result.captions, translate("subtitle"), translate("subtitles")), count(result.texts, "texto", "textos"), result.music ? translate("the music \"{0}\"", result.music) : translate("without music"), result.notes.length ? ` ${result.notes.join(" ")}` : "", voiceNote(chosen));
    if (stock !== false) return summary;
    const slots = result.slots.map((s, i) => translate("Scene {0}: start = {1}, duration = {2} {3}", i + 1, s.start, s.duration, input.voiceover ? translate(", the voice starts in {0}", s.voiceStart) : "")).join("\n");
    // Read by the user when a button ran it: there is nothing to watch until the graphics are drawn.
    const pending = translate("Time line mounted without stock video: {0} s with {1}, {2}, {3} and {4}. The image is missing: it is drawn with own graphics, scene by scene (nothing has been rendezvous). {5} {6}", result.duration.toFixed(1), count(result.voices, "voz", "voces"), count(result.captions, translate("subtitle"), translate("subtitles")), count(result.texts, "texto", "textos"), result.music ? translate("the music \"{0}\"", result.music) : translate("without music"), result.notes.length ? ` ${result.notes.join(" ")}` : "", voiceNote(chosen));
    return translate("{0}\nThe image is empty on purpose: draw each scene with create_graphic in its section (start and duration in seconds of assembly; within the graph time starts in 0):\n{1}", pending, slots);
  },
});

const generateVideo = tool({
  name: "generate_video",
  description:
    "Exporta el vídeo a MP4 (render y normalización de volumen): con la línea de tiempo montada exporta ese montaje tal cual; sin ella renderiza el guion directamente (voz que falte, b-roll, composición). Tarda varios minutos y corre en segundo plano; el usuario ve el progreso en el panel. Úsalo solo cuando pidan exportar, renderizar o el archivo final. Para pasar de un guion a algo que el usuario pueda ver y retocar usa build_timeline, que no renderiza.",
  schema: z.object({
    quality: z.enum(["draft", "looks", "delivery"]).optional().describe("draft = fast, looks = normal (default), delivery = maximum"),
  }),
  label: (i) => (i.quality === "draft" ? translate("Generate the video (draft)") : i.quality === "delivery" ? translate("Generate video (high quality)") : translate("Generate the video")),
  run: async (input, ctx) => {
    // A montage of the user's own footage has no script: nothing to voice, so no narrator is picked for it.
    const narrated = project(ctx).scenes.length > 0;
    const { chosen } = narrated ? await ensureVoice(ctx) : { chosen: null };
    const result = ctx.deps.startVideo(ctx.projectId, { quality: input.quality });
    if (!result.ok) throw new Error(result.error);
    return narrated
      ? translate("Video in progress: voice, b-roll, composition and render in background (several minutes).") + voiceNote(chosen)
      : translate("Exporting the assembly to MP4 in the background (a few minutes); progress comes on top of the view.");
  },
});

const previewScene = tool({
  name: "preview_scene",
  description: "Renderates a single-scene draft to see it on the panel (you need the audio of that scene ready).",
  schema: z.object({ scene: sceneNumber }),
  label: (i) => translate("Preview of the scene {0}", i.scene),
  run: (input, ctx) => {
    const scene = sceneAt(project(ctx), input.scene);
    const result = ctx.deps.startVideo(ctx.projectId, { sceneId: scene.id, quality: "draft" });
    if (!result.ok) throw new Error(result.error);
    return translate("Renderating the preview of the scene {0}.", input.scene);
  },
});

const cancelRender = tool({
  name: "cancel_render",
  description: "Cancel the current render or generation.",
  schema: z.object({}),
  label: () => translate("Cancel the render"),
  run: (_input, ctx) => {
    const running = project(ctx).videos.find((v) => isRenderActive(v.id));
    if (!running) throw new Error(translate("There's no render in progress."));
    cancelVideo(running.id);
    return translate("Render canceled.");
  },
});

const renameProjectTool = tool({
  name: "rename_project",
  description:
    "Change the name of the project (the one seen in the study and on the cover). Use it in the first shift when the project is called as a file (IMG_4101, VID-2024...) or \"Edit video,\" with a short name that says what it's about (2-6 words, no quotes). Do not change it if the user already named it.",
  schema: z.object({ title: z.string().trim().min(1).max(MAX_TITLE_CHARS) }),
  label: () => translate("Name the project"),
  run: (input, ctx) => {
    renameProject(ctx.projectId, input.title);
    return translate("Renowned project: \"{0}.\"", input.title);
  },
});

/** Tools whose input is the change itself: a button for them must carry it. */
const NEEDS_INPUT = new Set(["edit_workspace", "apply_edit_notes", "review_edit_notes", "set_style", "place_text", "analyze_media", "set_clip_effects", "arrange_clips", "rename_project"]);

const proposeActions = tool({
  name: "propose_actions",
  description:
    "Propose the user 1-3 next steps as buttons that run with one click, without calling you again. Each is one of the other tools with your input. Call it at the end of the shift, after what you have done, for the next that makes sense (generate the voice, generate the video, try another style...). Do not repeat what you have just done.",
  schema: z.object({
    message: z
      .string()
      .min(8)
      .max(700)
      .describe(
        "Your reply in the studio language. In one to three plain-text sentences, explain what changed and why, or what remains. For edits, include the clip order, how you chose the cuts, and what you added or omitted.",
      ),
    actions: z
      .array(
        z.object({
          label: z.string().min(2).max(40).describe("A short label in the studio language. Start with a verb."),
          tool: z.string(),
          input: z.record(z.string(), z.unknown()).default({}),
        }),
      )
      .min(1)
      .max(3),
  }),
  label: () => translate("Propose next steps"),
  run: (input, ctx) => {
    const review = currentNoteReview(ctx);
    if (review && review.revision !== project(ctx).edit.revision) throw new Error(translate("The review of the note is outdated. Read review_edit and review the changes in the current version."));
    if (review && pendingNotePages(review).length) throw new Error(translate("The note remains to be reviewed: call review_edit_notes with expectedRevision = {0} for the lots {1}. It is not enough with review_edit or with a single frame.", review.revision, pendingNotePages(review).join(", ")));
    const valid: AgentSuggestion[] = [];
    for (const action of input.actions) {
      const found = AGENT_TOOLS.find((t) => t.name === action.tool && t.name !== "propose_actions");
      if (!found) continue;
      if (!found.schema.safeParse(action.input).success) continue;
      // A button that would run one of these with nothing to apply is a no-op dressed up as an action.
      if (NEEDS_INPUT.has(found.name) && Object.keys(action.input).length === 0) continue;
      valid.push({ label: action.label, tool: action.tool, input: action.input });
    }
    if (valid.length === 0) throw new Error(translate("No proposed action is valid: use the exact name of a tool and its input."));
    ctx.message = noteReviewOutcome(ctx) ?? input.message.trim();
    // A generation held for the user's approval keeps its button, first: it is the step the turn waits on.
    const held = ctx.suggestions.filter((s) => s.label.startsWith("Aprobar:"));
    const rest = valid.filter((v) => !held.some((h) => h.tool === v.tool));
    ctx.suggestions.splice(0, ctx.suggestions.length, ...held, ...rest.slice(0, Math.max(1, 3 - held.length)));
    return `${valid.length} botones propuestos.`;
  },
});

const addVoiceoverTool = tool({
  name: "add_voiceover",
  description:
    "Añade voz en off al MONTAJE VISUAL solo cuando el prompt o la referencia la justifique. Dice cada frase con la voz del proyecto y la coloca en el segundo indicado. NO añade subtítulos salvo que se pidan o la referencia los justifique; captions permite decidirlos por separado. Sustituye la locución anterior y baja la música bajo la voz. Respeta la función narrativa y el tono de la referencia con frases propias, coordinadas con lo que se ve. Gasta crédito de voz.",
  schema: z.object({
    lines: z.array(z.object({
      text: z.string().min(2).max(600).describe("A natural spoken sentence in the requested video language. Spell out symbols as pronounced."),
      start: z.number().min(0).max(7200).describe("Second of the assembly in which it starts"),
    })).min(1).max(30),
    captions: z.boolean().optional().describe("Subtitles synchronized with voice; if omitted, respect your presence or absence in the reference"),
    captionAppearance: captionAppearanceSchema.partial().optional().describe("Subtitle style observed in the reference; do not impose generic box or size"),
    wordsPerCue: z.number().int().min(1).max(16).optional(),
  }),
  label: (i) => translate("Lucution on off ({0} phrases)", i.lines.length),
  run: async (input, ctx) => {
    const p = project(ctx);
    if (!p.edit.clips.length) throw new Error(translate("Add clips to the timeline before adding voiceover."));
    const { voiceId, chosen } = await ensureVoice(ctx);
    const textReference = p.edit.references.find((r) => r.roles.includes("style") && r.analysis)?.analysis?.text;
    const result = await ctx.deps.addVoiceover(ctx.projectId, voiceId, input.lines, {
      captions: input.captions ?? p.edit.direction?.captions ?? (textReference?.mode === "captions" || textReference?.mode === "both"),
      captionAppearance: { ...textReference?.appearance, ...input.captionAppearance },
      wordsPerCue: input.wordsPerCue ?? textReference?.wordsPerCue,
    });
    const total = editDuration(result.edit);
    const overrun = result.end > total - 0.05 && result.end > Math.max(0, ...result.edit.clips.filter((c) => result.edit.assets.find((a) => a.id === c.assetId)?.kind !== "audio").map((c) => c.start + c.duration)) + 0.2;
    const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
    return translate("Locution placed: {0} until the second {1} {2}; music down under the voice. {3} {4} {5}", count(result.lines, "frase", "frases"), result.end.toFixed(1), result.captions ? `, con ${count(result.captions, translate("subtitle"), translate("subtitles"))}` : "", result.shifted ? translate(" {0} not to step on the previous one.", result.shifted === 1 ? "Una frase se ha retrasado" : `${result.shifted} frases se han retrasado`) : "", overrun ? translate(" The voice ends after the image: shorten phrases or lengthen the assembly.") : "", voiceNote(chosen));
  },
});


const storyShot = z.object({
  moment: z.string().describe("Id del momento del registro de material, p. ej. C3.M2"),
  seconds: z.number().min(0.15).max(60).optional().describe("Track duration; with style reference uses its observed rhythm, also cuts of less than a second"),
  part: z.enum(["best", "start", "end", "whole"]).optional().describe("What part of the moment: the most stable (by default), the beginning, the end or whole"),
  speed: z.number().min(0.25).max(4).optional(),
});

/** The cut as the agent reviews it: the numbered list, the warnings, and a filmstrip it can look at. */
async function reviewText(ctx: AgentContext, header: string, warnings: string[] = []): Promise<string> {
  const p = project(ctx);
  const comparison: string[] = [];
  const styleReference = p.edit.references.find((r) => r.roles.includes("style") && r.analysis);
  if (styleReference?.analysis) {
    const analysis = styleReference.analysis;
    const picture = p.edit.clips.filter((c) => (c.track ?? 0) === 0 && p.edit.assets.some((a) => a.id === c.assetId && (a.kind === "video" || a.kind === "image")));
    if (picture.length) {
      const mean = picture.reduce((sum, c) => sum + c.duration, 0) / picture.length;
      const target = analysis.pacing.shotSeconds;
      comparison.push(translate("Reference \"{0} ': regular planes {1} s; current assembly {2} flat, mean {3} s. sought-after curve: {4}", styleReference.title, target, picture.length, mean.toFixed(2), analysis.pacing.progression));
      if (mean > target * 1.7 || mean < target / 1.7) warnings.push(translate("The rhythm is removed from the reference ({0} s versus {1} s by plane). It corrects the cuts or justifies the difference by the prompt; accelerating a take does not add cuts.", mean.toFixed(2), target));
    }
    const hasCaptions = p.edit.overlays.some((o) => o.kind === "caption");
    const wantsCaptions = p.edit.direction?.captions ?? (analysis.text.mode === "captions" || analysis.text.mode === "both");
    if (!wantsCaptions && hasCaptions) warnings.push(translate("There are subtitles although the chosen address or reference does not ask them: remove them unless the user has an explicit request."));
    comparison.push(translate("Text treatment of the reference: {0}. The explicit prompt has priority.", analysis.text.treatment));
    if (analysis.imagery && analysis.imagery.kind !== "footage") {
      const own = picture.filter((c) => isGraphic({ id: c.assetId })).length;
      comparison.push(translate("Reference image: {0}; assembly carries {1} of {2} planes with own graphics. Recipe: {3}", analysis.imagery.kind === "graphics" ? "dibujada" : translate("real video mix and graphics"), own, picture.length, analysis.imagery.recipe || translate("(no prescription saved: look at it with inspect_reference)")));
      if (analysis.imagery.kind === "graphics" && picture.length > own) warnings.push(translate("The reference is graphic and {0} flat are video or photo: replace them with own graphics in that style (create_graphic with refplaceClipId or start), unless the user has requested that material.", picture.length - own));
    }
  }
  for (const r of p.edit.references.filter((r) => r.roles.includes("script") && r.analysis)) {
    comparison.push(translate("It contrasts the story with \"{0}\": {1}. It is not enough for each sentence to name what is on screen.", r.title, r.analysis!.story.map((s) => `${s.purpose} → ${s.adaptation}`).join(" | ")));
  }
  const strip = await cutFilmstrip(p.edit, p.format === "vertical");
  if (strip.image) ctx.images = [...(ctx.images ?? []), strip.image];
  return [
    header,
    translate("CORTES (the attached image shows a frame of the center of each, in this order, from left to right and from top down):"),
    ...strip.lines,
    ...comparison,
    warnings.length ? `EDIT WARNINGS:\n- ${warnings.join("\n- ")}` : translate("No mounting notices."),
    translate("Check the strip as an assembly would: do you understand what happens in order?, the hook hitch?, are there rare jumps, repetitions or planes that do not contribute? For a note on an existing assembly, fix only the affected elements with apply_edit_notes and check with review_edit_notes; use build_edit only if the request is to mount or redo the structure."),
  ].join("\n");
}

const buildEdit = tool({
  name: "build_edit",
  description:
    "La forma principal de montar el MONTAJE VISUAL: un guion visual por partes (gancho, contexto, desarrollo, clímax, cierre…) con los momentos del FOOTAGE LOG por su id (C3.M2) en el orden en que deben verse. La herramienta elige el tramo exacto de cada momento (el más estable salvo que pidas start/end/whole), coloca los cortes, ajusta a la duración objetivo y devuelve la lista de cortes, avisos de montaje (retrocesos dentro de un clip, ida y vuelta entre clips, material repetido, desorden respecto a la grabación) y una tira de fotogramas del resultado para que la revises. Sustituye todos los clips de imagen; la música se adapta y los subtítulos acompañan a su trozo.",
  schema: z.object({
    beats: z.array(z.object({
      name: z.string().min(1).max(40).describe("Part of the story: Hook, Context, Step 1..., Result, Close"),
      shots: z.array(storyShot).min(1).max(40),
    })).min(1).max(12),
    targetDuration: z.number().min(2).max(900).optional().describe("Expected duration in seconds"),
    allowRewind: z.boolean().optional().describe("true only if you want to go back into the same clip on purpose (e.g. repeat an instant)"),
    clearTexts: z.boolean().optional(),
  }),
  label: (i) => translate("Mount {0} planes in {1} parts", i.beats.reduce((n, b) => n + b.shots.length, 0), i.beats.length),
  run: async (input, ctx) => {
    const current = project(ctx);
    const pending = current.edit.references.filter((r) => current.edit.assets.some((a) => a.id === r.assetId && (a.kind === "video" || a.kind === "image")) && (r.roles.includes("style") || r.roles.includes("script")) && !r.analysis);
    if (pending.length) throw new Error(translate("Before mounting, study the references and save their adaptation with save_reference_analysis: {0}. Use the visual evidence of the shift or inspect_reference; transcribe is not enough.", pending.map((r) => `${r.title} (id ${r.id})`).join(", ")));
    const clips = await footageLog(ctx.projectId);
    const pacing = current.edit.references.find((r) => r.roles.includes("style") && r.analysis)?.analysis?.pacing.shotSeconds;
    const beats = input.beats.map((b) => ({ ...b, shots: b.shots.map((s) => ({ ...s, seconds: s.seconds ?? pacing })) }));
    const { shots, warnings } = resolveStoryboard(clips, beats, { allowRewind: input.allowRewind, expectedShotSeconds: pacing });
    const changes = Object.fromEntries(clips.map((c) => [c.assetId, c.moments.slice(1).map((m) => m.from)]));
    // Read the montage only after the slow part: another tool of this turn may have saved meanwhile.
    const p = project(ctx);
    const { doc, picture, notes } = arrangeClips(p.edit, shots.map((s) => s.segment), { targetDuration: input.targetDuration, shots: changes, clearTexts: input.clearTexts });
    saveEditDocument(p.id, doc);
    const plan = input.beats.map((b) => `${b.name}: ${b.shots.map((s) => s.moment).join(", ")}`).join(" | ");
    return reviewText(ctx, translate("Saving assembly: {0} planes, {1} s image. Visual script: {2}. {3}", shots.length, picture.toFixed(1), plan, notes.length ? ` Notas: ${notes.join(" ")}` : ""), warnings);
  },
});

const applyNotes = tool({
  name: "apply_edit_notes",
  description: "Aplica notas a un montaje EXISTENTE mediante cambios parciales por ID. Envía solo campos afectados; conserva todos los otros elementos y campos, orden, recortes, pistas, audio y duración total. Operación atómica con expectedRevision. shiftFrames=-3 adelanta 3 fotogramas sin cambiar duración; volumeFactor=0.5 reduce el volumen actual a la mitad. No admite reemplazar assets ni listas completas. Para una nota general incluye TODAS las apariciones pertinentes; para una local solo los IDs/tramo indicados. Devuelve el cambio exacto y los lotes que debes revisar con review_edit_notes antes de responder. No repitas factores o desplazamientos ya aplicados.",
  schema: editNotesSchema,
  label: () => "Aplicar la nota conservando el resto",
  run: (input, ctx) => {
    const p = project(ctx);
    const previous = currentNoteReview(ctx);
    const range = previous?.range ?? input.range;
    if (range && input.range && (input.range.from < range.from || input.range.to > range.to)) throw new Error(translate("The note already has a limited section. Do not expand its scope in a correction."));
    const result = applyEditNotes(p.edit, { ...input, range: input.range ?? range });
    if (!result.changes.length) return translate("No change: the elements already have those values. Review {0}.", p.edit.revision);
    const saved = saveEditDocument(p.id, result.doc);
    ctx.noteReview = accumulateNoteReview(previous, saved, result.changes, range);
    ctx.message = undefined;
    saveNoteReview(p.id, ctx.noteReview);
    const warnings = noteWarnings(saved, result.changes, p.format === "vertical");
    return [
      translate("Note saved: {0} affected elements; review {1}. The fields and elements not included, the order of the lists, files, references, background and total duration have been retained.", result.changes.length, saved.revision),
      describeNoteChanges(result.changes),
      warnings.length ? `WARNINGS:\n${warnings.join("\n")}` : translate("No geometric notices of the texts concerned."),
      translate("Review required: {0} moments in {1} lots. Use review_edit_notes with expectedRevision = {2}, starting with page = 0; lots are numbered from scratch.", ctx.noteReview.times.length, Math.ceil(ctx.noteReview.times.length / NOTE_REVIEW_PAGE_SIZE), saved.revision),
      translate("Do not reconstruct the video or resynchronize the music. If you need to correct more than the same note, apply only that patch with the new review; the visual coverage will be reinitiated to review the final result."),
    ].join("\n");
  },
});

const reviewNotes = tool({
  name: "review_edit_notes",
  description: "Revisa TODOS los momentos afectados por apply_edit_notes, por lotes de 12 instantes. Muestra una composición ligera con todas las capas visibles, textos simultáneos, encuadre, zoom y transición en ese instante. Incluye inicio/final, cambios de plano y capas y muestras intermedias cada segundo. Lee y mira cada lote pendiente; corrige con apply_edit_notes si la nota sigue incumplida. El muestreo y las fuentes aproximadas no garantizan seguimiento continuo de caras ni equivalen a escuchar el sonido. No modifica el montaje. También retoma una revisión interrumpida.",
  schema: z.object({ expectedRevision: z.number().int().nonnegative(), page: z.number().int().nonnegative().default(0) }),
  label: (input) => `Revisar momentos afectados · lote ${input.page + 1}`,
  run: async (input, ctx) => {
    const p = project(ctx);
    const review = ctx.noteReview ?? readNoteReview(p.id);
    if (!review) throw new Error(translate("There is no implementation note yet to be revised."));
    if (p.edit.revision !== input.expectedRevision) throw new Error(translate("The assembly has changed; the current review is {0}. Read review_edit before continuing.", p.edit.revision));
    // Another client can change the picture under a text: invalidate old coverage and sample the current montage.
    if (review.revision !== p.edit.revision) ctx.noteReview = accumulateNoteReview(undefined, p.edit, review.changes.map((change) => ({ ...change,
      after: change.kind === "clip" ? p.edit.clips.find((c) => c.id === change.id) : p.edit.overlays.find((o) => o.id === change.id),
    })), review.range);
    else ctx.noteReview = review;
    const current = ctx.noteReview;
    const pages = Math.ceil(current.times.length / NOTE_REVIEW_PAGE_SIZE);
    if (!pages) {
      saveNoteReview(p.id, current);
      return translate("Review {0}: these changes do not alter image or text.\n{1}\nIt contrasts the values with the note. The audio has not been heard; a volume and synchrony check does not certify how it is heard.", p.edit.revision, describeNoteChanges(current.changes));
    }
    if (input.page >= pages) throw new Error(`Solo hay ${pages} lotes (0–${pages - 1}).`);
    const times = current.times.slice(input.page * NOTE_REVIEW_PAGE_SIZE, (input.page + 1) * NOTE_REVIEW_PAGE_SIZE);
    const preview = await notePreviewPage(p.edit, p.format === "vertical", times, current.changes, ctx.signal);
    ctx.signal?.throwIfAborted();
    if (project(ctx).edit.revision !== p.edit.revision || ctx.noteReview !== current) throw new Error(translate("The assembly or the note has changed while the images were generated. This lot does not count; it repeats the current review."));
    if (preview.image) ctx.images = [...(ctx.images ?? []), preview.image];
    if (preview.image && !preview.failures.length) { current.reviewed.add(input.page); current.unavailable.delete(input.page); }
    else { current.unavailable.add(input.page); current.reviewed.delete(input.page); }
    saveNoteReview(p.id, current);
    const pending = pendingNotePages(current);
    const active = times.map((time) => `${time.toFixed(3)} s: ${p.edit.overlays.filter((o) => o.start <= time && time < o.start + o.duration).map((o) => `${o.id} «${o.text.replace(/\s+/g, " ").slice(0, 100)}»`).join(" | ") || translate("without texts")}`);
    return [
      translate("Review {0}, lot {1} / {2}. Images in order of reading, with time marked; yellow = note texts; red = social interface.", p.edit.revision, input.page + 1, pages),
      ...active,
      ...preview.failures.map((failure) => `NO REVISADO: ${failure}`),
      pending.length ? translate("{0}. Continue before propose_actions.", pending.join(", ")) : translate("All the lots have been processed. Look at the images before you give the note as determined."),
      current.unavailable.size ? translate("INCOMPLETE REVISION: {0} lots without all their images; reinform them or indicate this limitation to the user.", current.unavailable.size) : "",
      translate("Check the note at each instant and the simultaneous layers: free face and subject, a legible idea, input / output and synchrony. The sources and boxes are approximate; the sampling does not amount to reviewing each frame or listening to the sound. If it fails, it only corrects the elements justified by the note."),
    ].filter(Boolean).join("\n");
  },
});

const reviewEdit = tool({
  name: "review_edit",
  description: "It shows the current assembly as a forklift would see it: the list of cuts and a strip with a frame of each. Use it after changing clips with other tools, or to check the result before responding.",
  schema: z.object({}),
  label: () => translate("Review the edit"),
  run: async (_input, ctx) => `${describeState(ctx.projectId)}\n${await reviewText(ctx, translate("Current assembly: {0} s. Review {1}.", editDuration(project(ctx).edit).toFixed(1), project(ctx).edit.revision))}`,
});

const inspectReference = tool({
  name: "inspect_reference",
  description: "Study a reference with large images to read your texts, ALL your cuts and a real transcript. It does not modify tracks. It allows to expand a section or study references that did not enter the initial images. Then save what you observed with save_reference_analysis.",
  schema: z.object({ referenceId: z.string(), from: z.number().min(0).optional(), to: z.number().min(0).optional(), frames: z.number().int().min(4).max(24).optional() }),
  label: () => translate("Study style, cuts and script of reference"),
  run: async (input, ctx) => {
    const study = await studyReference(ctx.projectId, input.referenceId, input);
    ctx.images = [...(ctx.images ?? []), ...study.images];
    return `${study.text}\n</reference_evidence>`;
  },
});

const saveReferenceAnalysis = tool({
  name: "save_reference_analysis",
  description: "Guarda el análisis OBSERVADO de la referencia y cómo se aplicará al montaje. Obligatorio antes de build_edit con referencias de estilo o guion. Usa las imágenes y transcripción de reference_evidence o inspect_reference: concreta el ritmo por tramos, títulos frente a subtítulos, aspecto y estructura narrativa. En imagery di de qué está hecha la imagen: si es dibujada (ilustración, recortes, infografía, motion graphics), escribe la receta para rehacerla con create_graphic; esa imagen no se sustituye por stock. No rellenes con valores genéricos ni inventes audio que no hayas escuchado.",
  schema: z.object({ referenceId: z.string(), analysis: referenceAnalysisSchema.required({ imagery: true }) }),
  label: () => translate("Save the reference adaptation criterion"),
  run: (input, ctx) => {
    const p = project(ctx);
    const reference = p.edit.references.find((r) => r.id === input.referenceId);
    if (!reference) throw new Error(translate("The reference is no longer in the project."));
    const asset = p.edit.assets.find((a) => a.id === reference.assetId);
    if (asset?.kind === "video" && reference.roles.includes("script") && !input.analysis.story.length) throw new Error(translate("The reference guides the script: it describes its narrative sections and how they will be adapted."));
    if (asset?.kind === "video" && input.analysis.story.some((s) => s.to > asset.duration + 0.05)) throw new Error(translate("The times of the analysis exceed the duration of the reference."));
    if (input.analysis.text.appearance.x + input.analysis.text.appearance.width > 100) throw new Error(translate("The text style comes out of the canvas."));
    const drawn = input.analysis.imagery.kind !== "footage";
    if (drawn && reference.roles.includes("style") && input.analysis.imagery.recipe.trim().length < 40) throw new Error(translate("The image of the reference is drawn: it writes in imagery.recipe how to redo it (palette in hex, background and textures, shapes and edges, typography, composition and movement)."));
    saveEditDocument(p.id, { ...p.edit, references: p.edit.references.map((r) => r.id === reference.id ? { ...r, analysis: input.analysis } : r) });
    return translate("\"{0}\" saved analysis: regular plans of {1} s, texts {2}, {3} narrative parts. Apply it in the cuts, the script and texts; explain any real difference. {4}", reference.title, input.analysis.pacing.shotSeconds, input.analysis.text.mode, input.analysis.story.length, drawn ? translate(" Its image is drawn: make it with own graphics (skill custom-graphics, create_graphic) following the saved recipe, not with stock video; with script, mount with build_timeline and stock = false.") : "");
  },
});

const inspectFootage = tool({
  name: "inspect_footage",
  description: "Look closely at a section of a clip: a strip of frames every few seconds between from and to. Use it when the material record is not enough to decide (where an action begins, what number is seen, which of two takes is better).",
  schema: z.object({
    clip: z.string().describe("Etiqueta del clip (C3) o id de un momento (C3.M2)"),
    from: z.number().min(0).max(7200).optional(),
    to: z.number().min(0).max(7200).optional(),
    frames: z.number().int().min(2).max(16).optional().describe("How many frames (by default 8)"),
  }),
  label: (i) => `Mirar ${i.clip}${i.from !== undefined ? translate(" from {0} s", i.from) : ""}`,
  run: async (input, ctx) => {
    const clips = await footageLog(ctx.projectId);
    const [label, momentPart] = input.clip.toUpperCase().split(".");
    const clip = clips.find((c) => c.label === label);
    if (!clip) throw new Error(translate("There is no clip {0}. Clips: {1}.", label, clips.map((c) => c.label).join(", ")));
    const moment = momentPart ? clip.moments.find((m) => m.id.toUpperCase() === `${label}.${momentPart}`) : undefined;
    const from = Math.max(0, input.from ?? moment?.from ?? 0);
    const to = Math.min(clip.duration, Math.max(from + 0.2, input.to ?? moment?.to ?? clip.duration));
    const count = clip.kind === "image" ? 1 : input.frames ?? 8;
    const times = Array.from({ length: count }, (_, i) => Math.round((from + ((i + 0.5) * (to - from)) / count) * 100) / 100);
    const asset = project(ctx).edit.assets.find((a) => a.id === clip.assetId);
    if (!asset) throw new Error(translate("That file is no longer in the project."));
    const image = await filmstrip(times.map((t) => ({ file: resolveInStorage(asset.path), t })), { vertical: asset.height > asset.width, cols: Math.min(count, 8) });
    if (image) ctx.images = [...(ctx.images ?? []), image];
    return translate("{0} \"{1},\" frames in t = {2} s (left to right, top down). {3}", clip.label, clip.name, times.join(", "), image ? "" : translate(" The image could not be removed."));
  },
});

const editWorkspace = tool({
  name: "edit_workspace",
  description: "Edit the visual assembly before the render. Replace only the lists you send: clips (assetId of the current state, track start, input to source, duration, volume, fit) and overlay (texts or subtitles with times and percentage positions). Keep the items you do not need to change. Never invent assets or transcripts. To add texts without replacing the list use place_text.",
  schema: z.object({ clips: z.array(editClipSchema).max(500).optional(), overlays: z.array(overlaySchema).max(3000).optional(), background: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(), duration: z.number().min(0.1).max(7200).optional(), direction: videoDirectionSchema.optional() }),
  label: () => translate("Edit clips and assembly layers"),
  run: (input, ctx) => {
    const p = project(ctx);
    const edit = saveEditDocument(p.id, { ...p.edit, ...input, enabled: true });
    return translate("Saving assembly: {0} clips, {1} texts / subtitles, {2}. The user can move them on the canvas before exporting.", edit.clips.length, edit.overlays.length, editDuration(edit).toFixed(2));
  },
});

const arrangeClipsTool = tool({
  name: "arrange_clips",
  description: "Monta el corte final: colocas los trozos de los vídeos e imágenes en el ORDEN en que deben verse (archivo, desde qué segundo del original y cuánto dura cada uno) y la herramienta calcula los tiempos en pista, ajusta a una duración objetivo si la das (recorta del final los trozos más largos, sin bajar de 0.8 s) y alinea inicios y finales a los cambios de plano para no cortar a mitad de movimiento. Sustituye todos los clips de imagen y vídeo; la música se ajusta a la nueva duración. Es la herramienta para «ordena», «acorta a 30 s» o «quédate con lo mejor»: no calcules start tú mismo con edit_workspace. Cada trozo: assetId (del estado), in (segundos del original, por defecto 0), duration (por defecto hasta el final), fit opcional (cover llena el cuadro recortando, contain muestra todo). Los subtítulos ya creados (transcripción) se reubican solos con su trozo de vídeo, así que NO hace falta transcribir de nuevo; los textos sueltos no se mueven (revísalos con place_text); clearTexts a true quita todos los textos y subtítulos.",
  schema: z.object({
    segments: z.array(z.object({ assetId: z.string(), in: z.number().min(0).max(7200).optional(), duration: z.number().min(0.2).max(7200).optional(), volume: z.number().min(0).max(1).optional(), fit: z.enum(["contain", "cover"]).optional(), speed: z.number().min(0.25).max(4).optional() })).min(1).max(200),
    targetDuration: z.number().min(2).max(900).optional().describe("Desired video duration in seconds"),
    clearTexts: z.boolean().optional(),
  }),
  label: (i) => translate("Order {0} pieces {1}", i.segments.length, i.targetDuration ? ` a ~${i.targetDuration} s` : ""),
  run: async (input, ctx) => {
    // Cached from the contact sheets the assistant already looked at: free after the first turn.
    const shots = Object.fromEntries((await assetOverviews(ctx.projectId)).map((o) => [o.assetId, o.shotChanges]));
    // Read the montage only after the slow part: another tool of this turn may have saved meanwhile.
    const p = project(ctx);
    const { doc, picture, notes } = arrangeClips(p.edit, input.segments, { targetDuration: input.targetDuration, shots, clearTexts: input.clearTexts });
    const saved = saveEditDocument(p.id, doc);
    return translate("Saving assembly: {0} pieces in order, image of {1} s, {2} clips in total. {3}", input.segments.length, picture.toFixed(1), saved.clips.length, notes.length ? ` Avisos: ${notes.join(" ")}` : "");
  },
});

const syncMusicToBeats = tool({
  name: "sync_music_to_beats",
  description: "Sincroniza la música con los cortes del montaje. Detecta los beats de la pista de música (la primera música del montaje o el clip que indiques con musicClipId). Si hay voz en el montaje, la voz y los subtítulos NO se mueven: se desliza la música hasta que sus golpes caigan lo más cerca posible de los cortes. Sin voz, los clips se ajustan para que cada corte caiga en un beat, cada uno con su duración aproximada. Llámala al final, después de ordenar, cortar y poner velocidades.",
  schema: z.object({ musicClipId: z.string().optional() }),
  label: () => translate("Synchronize the cuts with the music"),
  run: async (input, ctx) => {
    const p = project(ctx);
    // The first music of the montage is never a narration: sliding a voice clip would cut what it says.
    const music = p.edit.clips.find((c) => {
      const asset = p.edit.assets.find((a) => a.id === c.assetId);
      return asset?.kind === "audio" && (input.musicClipId ? c.id === input.musicClipId : !isNarration(asset));
    });
    if (!music) throw new Error(translate("There's no music clip in the assembly."));
    const analysis = (await analyzeMedia(p.id, music.assetId, "beats")) as { beats: number[]; bpm: number | null };
    // The analysis takes a while and tools of the same turn can run side by side: sync against the montage as it is now.
    const fresh = project(ctx);
    const current = fresh.edit.clips.find((c) => c.id === music.id);
    if (!current) throw new Error(translate("The music clip is no longer in the assembly."));
    const sync = syncMusic(fresh.edit, current, analysis.beats, analysis.bpm);
    saveEditDocument(fresh.id, sync.doc);
    const bpm = Math.round(sync.bpm);
    return sync.mode === "shift"
      ? translate("Music to {0} BPM slid under assembly: the cuts fall from half to {1} m of a beat (before {2} m. The voice and subtitles have not moved. {3}", bpm, (sync.after * 1000).toFixed(0), (sync.before * 1000).toFixed(0), sync.ducked ? translate(" I've lowered the music so it doesn't cover up the voice.") : "")
      : translate("Beat-adjusted cuts ({0} BPM): now they fall from average to {1} ms of a beat (before {2} ms). The loose texts have not moved.", bpm, (sync.after * 1000).toFixed(0), (sync.before * 1000).toFixed(0));
  },
});

const setClipEffects = tool({
  name: "set_clip_effects",
  description: "Da dinamismo al montaje sin reescribir los clips: transición de entrada (cut, fade = fundido, slide = deslizar, zoom) y movimiento de cámara lento (push = acercar, pull = alejar, alternate = alterna acercar/alejar clip a clip, none). Sin clipIds se aplica a todos los clips de imagen y vídeo; el primero y los trozos que continúan el mismo plano que el anterior se quedan en corte. Las transiciones y movimientos son efectos de 0.3 s dentro de cada clip: no cambian duraciones ni sincronía. speed (0.25 a 4, 1 = normal) cambia la velocidad: el clip conserva su sitio y duración en la pista y consume más o menos material del archivo (acelera el b-roll de paso, ralentiza un plano bonito; no aceleres clips con voz). Úsala para «edición dinámica» después de ordenar y cortar; con ritmo rápido mezcla zoom y deslizar, con tono sereno fundido y acercar.",
  schema: z.object({ clipIds: z.array(z.string()).max(500).optional(), transition: z.enum(CLIP_TRANSITIONS).optional(), motion: z.enum(EFFECT_MOTIONS).optional(), speed: z.number().min(0.25).max(4).optional() }).refine((v) => v.transition || v.motion || v.speed !== undefined, "Indica transition, motion, speed o varios."),
  label: (i) => i.clipIds?.length ? "Efectos en clips elegidos" : translate("Transmissions and camera movement"),
  run: (input, ctx) => {
    const p = project(ctx);
    if (!p.edit.clips.length) throw new Error(translate("There are no clips in the assembly."));
    const { doc, changed } = applyClipEffects(p.edit, input);
    if (changed === 0) return translate("The clips already had those effects: I haven't changed anything.");
    saveEditDocument(p.id, doc);
    return translate("Effects applied to {0} clips (transition: {1}, movement: {2}, speed: {3}). The user can change them to clip in the inspector.", changed, input.transition ?? translate("No change"), input.motion ?? translate("No change"), input.speed ?? translate("No change"));
  },
});

const placeText = tool({
  name: "place_text",
  description: "Create, update or delete a moving text in the canvas. Use the resources, design system and project plan to write. x / and are the top left corner in percentage; keep x + width < = 100 and text within the frame. If missing, a layer is added. Transcribed subtitles are obtained with analyze_media, they are not invented.",
  schema: overlaySchema.omit({ id: true }).partial().extend({ id: z.string().optional(), remove: z.boolean().optional() }),
  label: (i) => i.remove ? translate("Remove text from canvas") : translate("Place text on the canvas"),
  run: async (input, ctx) => {
    const p = project(ctx), { remove, id, ...patch } = input;
    const existing = p.edit.overlays.find((o) => o.id === id);
    if (id && !existing) throw new Error(translate("This text does not exist in the current assembly."));
    if (!existing && !patch.text) throw new Error(translate("Write the content of the new text."));
    const referenceLook = p.edit.references.find((r) => r.roles.includes("style") && r.analysis)?.analysis?.text.appearance;
    const overlay = { ...(existing ?? { ...newOverlay(patch.text!, 0, Math.min(p.edit.duration, 5)), ...referenceLook }), ...patch };
    if (overlay.x + overlay.width > 100) throw new Error(translate("The text comes out of the canvas: it reduces X or width."));
    const overlays = remove ? p.edit.overlays.filter((o) => o.id !== id) : existing ? p.edit.overlays.map((o) => o.id === id ? overlay : o) : [...p.edit.overlays, overlay];
    saveEditDocument(p.id, { ...p.edit, enabled: true, overlays });
    if (remove) return translate("Text deleted.");
    // One line: the chat shows a button's result by its first line, and a text may hold line breaks.
    const summary = translate("Editable text {0}: \"{1},\" {2} - {3} s, position ({4}%, {5}%).", overlay.id, overlay.text.replace(/\s*\n\s*/g, " "), overlay.start, overlay.start + overlay.duration, overlay.x, overlay.y);
    // What can be measured is checked here; what needs eyes (faces, the subject) the agent judges on the preview.
    const saved = project(ctx).edit;
    const warnings = [...textWarnings(overlay, p.format === "vertical"), ...(await textReadability(saved, overlay, p.format === "vertical"))];
    const notes = warnings.length ? translate("\nTEXT WARNINGS (run them with place_text before responding, unless the user has asked for it or the notice says you can stay):\n- {0}", warnings.join("\n- ")) : "";
    // Show the agent how it looks, as the filmstrip shows its cuts: it corrects before telling the user it's done.
    const preview = await textPreview(project(ctx).edit, overlay, p.format === "vertical");
    if (!preview) return `${summary}${notes}`;
    ctx.images = [...(ctx.images ?? []), preview];
    return translate("{0} {1}\nThe attached image shows how it remains in the second {2}: yellow box = text; red stripes = what covers the social network interface. Look at it as a fork: if the text touches a face, a few eyes, hands or the main subject, or is not read on the background, move it, change the size or put it in a box and look back at it before responding.", summary, notes, (overlay.start + Math.min(0.6, overlay.duration / 2)).toFixed(1));
  },
});

const analyzeWorkspaceMedia = tool({
  name: "analyze_media",
  description: "Transcribes the REAL audio to read its script, or removes silences from the assembly. Transcribing NO active subtitles: use addCaptions = true only if the prompt or the reference justifies them. References only keep context and never add layers. Use assetId and, for silences, clipId. Do not invent words or use TTS; the local model can be downloaded the first time.",
  schema: z.object({ assetId: z.string(), clipId: z.string().optional(), operation: z.enum(["transcribe", "silences"]), addCaptions: z.boolean().default(false) }),
  label: (i) => i.operation === "transcribe" ? translate("Transcribing the original audio") : translate("Remove Seats from Mounting"),
  run: async (input, ctx) => {
    const p = project(ctx);
    const asset = p.edit.assets.find((a) => a.id === input.assetId);
    if (!asset) throw new Error(translate("File not found."));
    const target = p.edit.clips.find((c) => c.assetId === asset.id && (!input.clipId || c.id === input.clipId));
    if (input.operation === "silences" && !target) throw new Error(translate("Add the file to a track before cutting silences."));
    const result = await analyzeMedia(p.id, asset.id, input.operation);
    // Reject a stale save if another editing client changed the document while analysis ran.
    if ("captions" in result && result.captions) {
      const cur = project(ctx); // the montage as it is after the (slow) transcription, not before
      const targets = cur.edit.clips.filter((c) => c.assetId === asset.id);
      // With word timings the subtitles follow the words that are in the montage (also after cutting phrases).
      const captions = !input.addCaptions ? [] : "words" in result && result.words ? montageCaptions(cur.edit, asset.id, result.words, cur.edit.overlays.find((o) => o.kind === "caption")) : captionsForClips(result.captions, targets);
      const overlays = input.addCaptions ? [...cur.edit.overlays.filter((o) => o.kind !== "caption" || !targets.some((c) => o.start < c.start + c.duration && o.start + o.duration > c.start)), ...captions] : cur.edit.overlays;
      const edit = { ...cur.edit, enabled: cur.edit.enabled || captions.length > 0, overlays, assets: cur.edit.assets.map((a) => a.id === asset.id ? { ...a, context: translate("Transcript of the original audio:\n{0}", result.captions!.map((o) => `${o.start.toFixed(2)} s: ${o.text}`).join("\n")).slice(0, 16000) } : a) };
      saveEditDocument(p.id, edit, true);
      return translate("Transcript saved in the context of the file. {0} subtitles added to the tracks.", captions.length);
    }
    if ("log" in result && typeof result.log === "string" && target) {
      const ranges = keptRanges(result.log, target.in, target.duration);
      if (!ranges.length) throw new Error(translate("The full clip was detected as silence: nothing has been deleted."));
      const next = rippleSilences(p.edit, target, ranges);
      saveEditDocument(p.id, next);
      return translate("Self-cuts saved; duration {0}. Video, texts and audio keep the synchronization.", editDuration(next).toFixed(2));
    }
    throw new Error(translate("The analysis did not return usable results."));
  },
});

export const AGENT_TOOLS = [
  applyNotes,
  reviewNotes,
  inspectReference,
  saveReferenceAnalysis,
  buildEdit,
  reviewEdit,
  inspectFootage,
  analyzeWorkspaceMedia,
  ...TRANSCRIPT_TOOLS,
  editWorkspace,
  addVoiceoverTool,
  arrangeClipsTool,
  setClipEffects,
  syncMusicToBeats,
  placeText,
  ...GRAPHIC_TOOLS,
  ...COMPOSITION_TOOLS,
  writeScript,
  editScene,
  addScene,
  removeScene,
  moveScene,
  setStyle,
  findBroll,
  changeShot,
  nextClip,
  generateVoice,
  buildTimeline,
  generateVideo,
  previewScene,
  cancelRender,
  renameProjectTool,
  ...STYLE_TOOLS,
  ...PASS_TOOLS,
  proposeActions,
] as unknown as AgentTool[];

/** Tools that gate the result on slow or paid work: never run by a suggestion without the user's click. */
export function toolByName(name: string): AgentTool | undefined {
  return AGENT_TOOLS.find((t) => t.name === name);
}

export type RunResult = { ok: true; message: string; label: string } | { ok: false; error: string; label: string };

/** Runs one tool directly (an action button): validates the input like the model's call would be. */
export async function runToolDirect(name: string, rawInput: unknown, ctx: AgentContext): Promise<RunResult> {
  const found = toolByName(name);
  if (!found || name === "propose_actions") return { ok: false, error: translate("Unknown action: {0}.", name), label: name };
  const parsed = found.schema.safeParse(rawInput ?? {});
  if (!parsed.success) {
    return { ok: false, error: translate("Data not valid for {0}: {1}", name, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")), label: name };
  }
  const label = found.label(parsed.data);
  try {
    return { ok: true, message: await found.run(parsed.data, ctx), label };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), label };
  }
}

// ---------------------------------------------------------------- state for the model

/** How the assistant must treat the user's references (sent with the state whenever there are any). */
const REFERENCE_GUIDE = "REFERENCIAS del usuario (en user_resources): guían el resultado, NO son material del montaje; sus archivos nunca van en clips. Según sus roles: style = imita el look y el ritmo (duración de los planos, tipo de transiciones y movimiento, colores, posición y estilo de los textos) que ves en su hoja de contactos y sus cambios de plano, y también DE QUÉ ESTÁ HECHA su imagen: si es dibujada (ilustración, recortes de papel, infografía, motion graphics), la imagen de tu vídeo se dibuja en ese estilo con create_graphic y no se cubre con vídeo de stock; script = sigue su estructura, gancho, tono y llamada a la acción para escribir guion, textos o el orden del relato, con tus palabras y sin copiar frases literales (si es un vídeo sin transcripción, transcríbelo con analyze_media: guarda el texto como contexto sin añadirlo a las pistas); brand = respeta colores, logo, nombre y tono de voz; product = describe el producto y su interfaz real con fidelidad, sin inventar funciones. Cuando uses una referencia, di en el message qué has tomado de ella.";

/** A compact picture of the project for the model: what exists and what each scene says. */
export function describeState(projectId: string): string {
  const p = getProject(projectId);
  if (!p) return translate("The project does not exist.");
  const lines: string[] = [
    translate("Project: \"{0}.\" Subject: {1}.", p.title || translate("without title"), p.topic || translate("(empty)")),
    translate("Adjustments: {0}, target {1} s, tone {2}, style {3}, subtitles {4}, transition {5}, music {6} {7}, effects {8} ({9} files), voice {10}.", p.format === "vertical" ? "9:16" : "16:9", p.targetDurationSec, p.tone, p.preset, p.captionStyle, p.transition, p.music, listMusic().length ? translate(" (tracks: {0})", listMusic().join(", ")) : translate(" (empty folder)"), p.sfx ? translate("Yes") : "no", listSfx().length, p.voiceId ? "elegida" : translate("WITHOUT ELIGIR")),
  ];
  if (p.edit.direction) lines.push(translate("Resources chosen according to prompt and references (not required): {0}", JSON.stringify(p.edit.direction)));
  lines.push(describeStyleForAgent(p.id));
  if (p.edit.enabled || p.edit.assets.length || p.edit.references.length) {
    lines.push(translate("VISUAL MONTAJE {0}: review {1}, 30 fps, duration {2} s, background {3}. {4}", p.edit.enabled ? translate("ACTIVE (for notes, use apply_edit_notes and review_edit_notes; do not reconstruct the script)") : "guardado", p.edit.revision, editDuration(p.edit), p.edit.background, hasScriptTimeline(p.edit) ? translate(" It is the MONTado GUION with build_timeline: its clips \"Scene N ·...\" are the b-roll of each plane, \"Locution N\" the voice of each scene, and the subtitles follow that voice.") : ""));
    const note = readNoteReview(projectId);
    if (note && (pendingNotePages(note).length || note.unavailable.size)) lines.push(translate("NOTE WITH INCOMPLETE REVISION {0}: if the user requests to continue it, use review_edit_notes with expectedRevision = {1}; pending lots {2}; unimaginable lots {3}. Do not apply your volume factors or displacements again. A question or new request does not require you to retake that note.", note.revision !== p.edit.revision ? translate(" (assembly has changed and its coverage will be reinitiated)") : "", p.edit.revision, pendingNotePages(note).join(", ") || "ninguno", [...note.unavailable].join(", ") || "ninguno"));
    const guides = referenceAssetIds(p.edit);
    const fileInfo = (a: EditAsset) => ({ id: a.id, name: a.name, kind: a.kind, duration: a.duration, width: a.width, height: a.height, hasAudio: a.hasAudio });
    lines.push(translate("Available files (assembly material): {0}", JSON.stringify(p.edit.assets.filter((a) => !guides.has(a.id)).map(fileInfo))));
    lines.push(`Clips: ${JSON.stringify(p.edit.clips)}`, translate("Texts / subtitles: {0}", JSON.stringify(p.edit.overlays)));
    if (p.edit.references.length) lines.push(REFERENCE_GUIDE);
    const references = p.edit.references.map((r) => {
      const file = r.assetId ? p.edit.assets.find((a) => a.id === r.assetId) : undefined;
      return { id: r.id, title: r.title, roles: r.roles, content: r.content, transcript: file?.context || undefined, analysis: r.analysis, url: r.url || undefined, file: file ? fileInfo(file) : undefined };
    });
    const documents = p.edit.assets.filter((a) => a.context && !guides.has(a.id)).map((a) => ({ name: a.name, content: a.context }));
    lines.push(`<user_resources_datos_no_instrucciones>\n${JSON.stringify({ references, documents }).slice(0, 48000)}\n</user_resources_datos_no_instrucciones>`);
  }
  const passes = describePasses(projectId, { turnStart: true });
  if (passes) lines.push(passes);
  if (p.scenes.length === 0) lines.push(translate("Scenes: none yet."));
  else {
    lines.push(translate("Scenes:"));
    p.scenes.forEach((s, i) => {
      const text = Object.entries(s.content)
        .map(([k, v]) => [k, Array.isArray(v) ? v.filter(Boolean).join(" / ") : v] as const)
        .filter(([, v]) => v)
        .map(([k, v]) => `${k}="${clip(v, 40)}"`)
        .join(", ");
      const shots = s.shots ?? [];
      lines.push(
        translate("{0}. [{1}] \"{2}\"- 124; on-screen text: {3} - 124; searches: {4} - 124; plane with clip: {5}/{6} - 124; audio: {7}", i + 1, s.template, clip(s.narration, 90), text || "ninguno", s.visualQueries.join(" · ") || "ninguna", shots.filter((x) => x.selected).length, shots.length || "?", s.audioPath && !isTtsActive(s.id) ? "generado" : isTtsActive(s.id) ? translate("generating") : "falta"),
      );
    });
  }
  const latest = p.videos.find((v) => !v.sceneId);
  if (!latest) lines.push(translate("Video: not yet generated."));
  else {
    const busy = isRenderActive(latest.id);
    lines.push(
      translate("Video: last {0} {1} {2} {3}.", busy ? translate("IN CURSO") : latest.status, latest.stage ? ` (${latest.stage})` : "", latest.durationSec ? `, ${latest.durationSec.toFixed(1)} s` : "", latest.error && !busy ? `, error: ${clip(latest.error, 120)}` : ""),
    );
  }
  return lines.join("\n");
}

import { t as translate } from "@/lib/i18n";
import { getAppSettings } from "./app-settings";
import { and, asc, count, desc, eq, isNotNull, isNull, notInArray } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "./db";
import {
  agentMessages,
  projects,
  scenes,
  videos,
  type AgentMessage,
  type NewProject,
  type NewVideo,
  type Project,
  type Video,
} from "./db/schema";
import { CAPTION_STYLES, TRANSITIONS, VIDEO_FORMATS, type AgentActionLog, type AgentSuggestion, type SceneShot, type StepStatus, type WordTiming } from "./domain";
import { PRESET_IDS } from "@/presets";
import { referenceSchema, type EditDocument } from "./editing/schema";
import { env } from "./env";
import type { EditableScript, ScriptDraft } from "./script/schema";
import { registerGlobalAsset } from "./global-assets";

export interface ProjectListItem extends Project {
  sceneCount: number;
}

export function listProjects(): ProjectListItem[] {
  const db = getDb();
  return db
    .select({ project: projects, sceneCount: count(scenes.id) })
    .from(projects)
    .leftJoin(scenes, eq(scenes.projectId, projects.id))
    .groupBy(projects.id)
    .orderBy(desc(projects.updatedAt))
    .all()
    .map((row) => withReferenceRoles({ ...row.project, sceneCount: row.sceneCount }));
}

/**
 * The montage is stored as JSON and read without parsing: references saved before they had roles
 * (a single `type`) get their roles here, so every reader can rely on them.
 */
function withReferenceRoles<T extends { edit: EditDocument }>(row: T): T {
  const references = row.edit?.references;
  if (!references?.length || references.every((r) => Array.isArray(r.roles))) return row;
  return { ...row, edit: { ...row.edit, references: references.flatMap((r) => { const parsed = referenceSchema.safeParse(r); return parsed.success ? [parsed.data] : []; }) } };
}

/** Thumbnail of the first chosen b-roll shot, in scene order: the project's cover on the home page. */
export function projectCover(projectId: string): string | null {
  const project = getDb().select({ edit: projects.edit }).from(projects).where(eq(projects.id, projectId)).get();
  const clip = project?.edit.clips.find((clip) => project.edit.assets.some((asset) => asset.id === clip.assetId && (asset.kind === "video" || asset.kind === "image")));
  if (clip) return `/api/projects/${projectId}/media/${clip.assetId}/thumbnail`;
  const rows = getDb()
    .select({ shots: scenes.shots })
    .from(scenes)
    .where(eq(scenes.projectId, projectId))
    .orderBy(asc(scenes.position))
    .all();
  for (const row of rows) for (const shot of row.shots ?? []) if (shot.selected?.thumbUrl) return shot.selected.thumbUrl;
  return null;
}

export function getProject(id: string) {
  const db = getDb();
  const project = db.query.projects
    .findFirst({
      where: eq(projects.id, id),
      with: {
        scenes: { orderBy: asc(scenes.position) },
        videos: { orderBy: desc(videos.createdAt) },
      },
    })
    .sync();
  return project && withReferenceRoles(project);
}

export type ProjectWithRelations = NonNullable<ReturnType<typeof getProject>>;

/** Voice for a new project: the one chosen in Ajustes, the configured default, else the one used most recently. */
export function defaultVoiceId(): string | null {
  const chosen = getAppSettings().defaults.voiceId;
  if (chosen) return chosen;
  const configured = env().TTS_DEFAULT_VOICE_ID;
  if (configured) return configured;
  const last = getDb()
    .select({ voiceId: projects.voiceId })
    .from(projects)
    .where(isNotNull(projects.voiceId))
    .orderBy(desc(projects.updatedAt))
    .limit(1)
    .get();
  return last?.voiceId ?? null;
}

/**
 * Words per second a voice really speaks, measured on the narration it has already generated (voices go
 * from 2.3 to 2.8), or null until it has said enough to tell. Budgets the next script's length.
 */
export function voicePace(voiceId: string | null): number | null {
  if (!voiceId) return null;
  const rows = getDb()
    .select({ narration: scenes.narration, seconds: scenes.audioDurationSec })
    .from(scenes)
    .innerJoin(projects, eq(scenes.projectId, projects.id))
    .where(and(eq(projects.voiceId, voiceId), isNotNull(scenes.audioDurationSec)))
    .orderBy(desc(projects.updatedAt))
    .limit(60)
    .all();
  let words = 0;
  let seconds = 0;
  for (const row of rows) {
    if (!row.seconds || row.seconds <= 0) continue;
    words += row.narration.trim().split(/\s+/).filter(Boolean).length;
    seconds += row.seconds;
  }
  return words >= 25 && seconds > 0 ? Math.min(3.4, Math.max(1.8, words / seconds)) : null;
}

export function createProject(values: Partial<NewProject> = {}): Project {
  const db = getDb();
  return db
    .insert(projects)
    .values({ voiceId: defaultVoiceId(), ...values })
    .returning()
    .get();
}

export const MAX_TITLE_CHARS = 120;

export function renameProject(id: string, title: string): void {
  getDb().update(projects).set({ title: title.trim().slice(0, MAX_TITLE_CHARS) }).where(eq(projects.id, id)).run();
}

export function deleteProject(id: string): void {
  getDb().delete(projects).where(eq(projects.id, id)).run();
}

export const MAX_TOPIC_CHARS = 2000;

export const projectSettingsSchema = z.object({
  topic: z.string().max(MAX_TOPIC_CHARS),
  targetDurationSec: z.coerce.number().int().min(10).max(180),
  tone: z.string().max(60),
  format: z.enum(VIDEO_FORMATS),
  voiceId: z.string().max(100).nullable().optional(),
  preset: z.enum(PRESET_IDS).default("viral"),
  captionStyle: z.enum(CAPTION_STYLES).default("pop"),
  transition: z.enum(TRANSITIONS).default("auto"),
  music: z.string().max(200).default("auto"),
  sfx: z.boolean().default(true),
});

export type ProjectSettings = z.infer<typeof projectSettingsSchema>;

export function updateProjectSettings(id: string, settings: ProjectSettings): void {
  getDb()
    .update(projects)
    .set({ ...settings, topic: settings.topic.trim(), tone: settings.tone.trim() })
    .where(eq(projects.id, id))
    .run();
}

export function setScriptStatus(id: string, status: StepStatus, error: string | null = null): void {
  getDb().update(projects).set({ scriptStatus: status, scriptError: error }).where(eq(projects.id, id)).run();
}

export function getScene(id: string) {
  return getDb().select().from(scenes).where(eq(scenes.id, id)).get();
}

export function setSceneTtsStatus(id: string, status: StepStatus, error: string | null = null): void {
  getDb().update(scenes).set({ ttsStatus: status, ttsError: error }).where(eq(scenes.id, id)).run();
}

export function setSceneAudio(
  id: string,
  audio: { audioHash: string; audioPath: string; audioDurationSec: number; words: WordTiming[] },
): void {
  getDb()
    .update(scenes)
    .set({ ...audio, ttsStatus: "done", ttsError: null })
    .where(eq(scenes.id, id))
    .run();
  try {
    const s = getDb().select().from(scenes).where(eq(scenes.id, id)).get();
    if (s && audio.audioPath) {
      registerGlobalAsset({
        name: translate("Luction {0} .mp3", s.position + 1),
        kind: "audio",
        source: "generated",
        path: audio.audioPath,
        duration: audio.audioDurationSec,
        hasAudio: true,
        context: s.narration ? translate("Voice of the scene {0}: \"{1}\"", s.position + 1, s.narration.slice(0, 100)) : translate("Voice generated"),
        projectId: s.projectId,
      });
    }
  } catch { /* ignore non-blocking registration */ }
}

/** Marks the project as changed, so an open editor reloads its state. */
export function touchProject(id: string): void {
  getDb().update(projects).set({ updatedAt: new Date() }).where(eq(projects.id, id)).run();
}

export function setSceneVisualQueries(id: string, visualQueries: string[]): void {
  getDb().update(scenes).set({ visualQueries }).where(eq(scenes.id, id)).run();
}

export function setSceneShots(id: string, shots: SceneShot[] | null): void {
  getDb().update(scenes).set({ shots }).where(eq(scenes.id, id)).run();
}

export function createVideo(values: NewVideo): Video {
  return getDb().insert(videos).values(values).returning().get();
}

/** Newest full-video version of a project (previews excluded). */
export function latestVideo(projectId: string): Video | undefined {
  return getDb()
    .select()
    .from(videos)
    .where(and(eq(videos.projectId, projectId), isNull(videos.sceneId)))
    .orderBy(desc(videos.createdAt))
    .limit(1)
    .get();
}

export function getVideo(id: string): Video | undefined {
  return getDb().select().from(videos).where(eq(videos.id, id)).get();
}

export function updateVideo(id: string, values: Partial<NewVideo>): void {
  getDb().update(videos).set(values).where(eq(videos.id, id)).run();
}

/** Replaces the whole script with a freshly generated draft. */
export function replaceScript(projectId: string, draft: ScriptDraft): void {
  const db = getDb();
  db.transaction((tx) => {
    tx.delete(scenes).where(eq(scenes.projectId, projectId)).run();
    if (draft.scenes.length) {
      tx.insert(scenes)
        .values(
          draft.scenes.map((scene, position) => ({
            projectId,
            position,
            template: scene.template,
            narration: scene.narration,
            content: scene.content,
            visualQueries: scene.visuals,
          })),
        )
        .run();
    }
    tx.update(projects)
      .set({ title: draft.title, scriptStatus: "done", scriptError: null })
      .where(eq(projects.id, projectId))
      .run();
  });
}

/**
 * Saves a script edited in the UI. Scenes keep their id (and so their
 * generated audio) when they still exist; new ones are inserted, removed
 * ones deleted, and positions follow the array order.
 */
export function saveScript(projectId: string, script: EditableScript): void {
  const db = getDb();
  db.transaction((tx) => {
    const existingIds = new Set(
      tx.select({ id: scenes.id }).from(scenes).where(eq(scenes.projectId, projectId)).all().map((r) => r.id),
    );
    const keptIds = script.scenes.map((s) => s.id).filter((id): id is string => !!id && existingIds.has(id));

    tx.delete(scenes)
      .where(keptIds.length ? and(eq(scenes.projectId, projectId), notInArray(scenes.id, keptIds)) : eq(scenes.projectId, projectId))
      .run();

    script.scenes.forEach((scene, position) => {
      const values = {
        position,
        template: scene.template,
        narration: scene.narration.trim(),
        content: scene.content,
        visualQueries: (scene.visualQueries ?? []).map((q) => q.trim()).filter(Boolean),
      };
      if (scene.id && existingIds.has(scene.id)) {
        tx.update(scenes).set(values).where(eq(scenes.id, scene.id)).run();
      } else {
        tx.insert(scenes).values({ projectId, ...values }).run();
      }
    });

    tx.update(projects).set({ title: script.title.trim() }).where(eq(projects.id, projectId)).run();
  });
}

export function addAgentMessage(
  projectId: string,
  message: {
    role: "user" | "assistant";
    text: string;
    actions?: AgentActionLog[];
    suggestions?: AgentSuggestion[];
    /** The montage before the turn and the revision after it, when the turn changed it (enables undo). */
    undo?: { before: EditDocument; revisionAfter: number };
  },
): AgentMessage {
  return getDb()
    .insert(agentMessages)
    .values({
      projectId,
      role: message.role,
      text: message.text,
      actions: message.actions ?? [],
      suggestions: message.suggestions ?? [],
      editBefore: message.undo?.before ?? null,
      editRevisionAfter: message.undo?.revisionAfter ?? null,
    })
    .returning()
    .get();
}

export function getAgentMessage(projectId: string, messageId: string): AgentMessage | undefined {
  return getDb().select().from(agentMessages).where(and(eq(agentMessages.projectId, projectId), eq(agentMessages.id, messageId))).get();
}

/** Forgets the undo snapshot of a message (after it was used, or when a newer turn replaced it). */
export function clearAgentUndo(projectId: string, messageId?: string): void {
  getDb()
    .update(agentMessages)
    .set({ editBefore: null, editRevisionAfter: null })
    .where(messageId ? and(eq(agentMessages.projectId, projectId), eq(agentMessages.id, messageId)) : eq(agentMessages.projectId, projectId))
    .run();
}

/** The conversation of a project, oldest first (the last `limit` messages). */
export function listAgentMessages(projectId: string, limit = 60): AgentMessage[] {
  return getDb()
    .select()
    .from(agentMessages)
    .where(eq(agentMessages.projectId, projectId))
    .orderBy(desc(agentMessages.createdAt), desc(agentMessages.id))
    .limit(limit)
    .all()
    .reverse();
}

export function clearAgentMessages(projectId: string): void {
  getDb().delete(agentMessages).where(eq(agentMessages.projectId, projectId)).run();
}

import { relations, sql } from "drizzle-orm";
import type { EditDocument } from "../editing/schema";
import { emptyEditDocument } from "../editing/schema";
import { PRESET_IDS } from "@/presets";
import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import {
  CAPTION_STYLES,
  STEP_STATUSES,
  TRANSITIONS,
  TEMPLATE_IDS,
  VIDEO_FORMATS,
  VIDEO_STATUSES,
  type AgentActionLog,
  type AgentSuggestion,
  type SceneContent,
  type SceneShot,
  type WordTiming,
} from "../domain";

const id = () =>
  text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID());

const timestamps = {
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date())
    .$onUpdateFn(() => new Date()),
};

/** A video idea: topic, settings and the editable script (its scenes). */
export const projects = sqliteTable("projects", {
  id: id(),
  edit: text("edit", { mode: "json" }).$type<EditDocument>().notNull().$defaultFn(emptyEditDocument).default(sql`'{"enabled":false,"revision":0,"duration":15,"background":"#101018","assets":[],"clips":[],"overlays":[],"references":[]}'`),
  title: text("title").notNull().default(""),
  topic: text("topic").notNull().default(""),
  targetDurationSec: integer("target_duration_sec").notNull().default(45),
  tone: text("tone").notNull().default("informativo"),
  format: text("format", { enum: VIDEO_FORMATS }).notNull().default("vertical"),
  voiceId: text("voice_id"),
  /** Style preset: sets the video's accent colours (and, when applied, caption style and transition). */
  preset: text("preset", { enum: PRESET_IDS }).notNull().default("viral"),
  captionStyle: text("caption_style", { enum: CAPTION_STYLES }).notNull().default("pop"),
  transition: text("transition", { enum: TRANSITIONS }).notNull().default("auto"),
  /** "auto" (a track from storage/music, fixed per project), "none", or a file name in storage/music. */
  music: text("music").notNull().default("auto"),
  /** Play an effect from storage/sfx on animated transitions. */
  sfx: integer("sfx", { mode: "boolean" }).notNull().default(true),
  scriptStatus: text("script_status", { enum: STEP_STATUSES }).notNull().default("idle"),
  scriptError: text("script_error"),
  ...timestamps,
});

/** One scene of a project's script, plus its generated narration audio. */
export const scenes = sqliteTable(
  "scenes",
  {
    id: id(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    template: text("template", { enum: TEMPLATE_IDS }).notNull(),
    narration: text("narration").notNull().default(""),
    /** On-screen text; its shape depends on `template` (validated by the template's zod schema). */
    content: text("content", { mode: "json" })
      .$type<SceneContent>()
      .notNull()
      .default(sql`'{}'`),
    /** English stock-footage searches for this scene (2-3), written by the LLM and editable. */
    visualQueries: text("visual_queries", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    /** B-roll shots in order; null until the visuals step has run. */
    shots: text("shots", { mode: "json" }).$type<SceneShot[]>(),
    ttsStatus: text("tts_status", { enum: STEP_STATUSES }).notNull().default("idle"),
    ttsError: text("tts_error"),
    /** Cache key of the audio (text + voice + model + settings). Differs from the current key => stale. */
    audioHash: text("audio_hash"),
    /** Storage-relative path to the audio file. */
    audioPath: text("audio_path"),
    /** Real duration measured with ffprobe. */
    audioDurationSec: real("audio_duration_sec"),
    words: text("words", { mode: "json" }).$type<WordTiming[]>(),
    ...timestamps,
  },
  (t) => [index("scenes_project_position_idx").on(t.projectId, t.position)],
);

/** One render (version) of a project: composition + HyperFrames render -> MP4. */
export const videos = sqliteTable(
  "videos",
  {
    id: id(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** Set for a single-scene preview; null for the full video. */
    sceneId: text("scene_id").references(() => scenes.id, { onDelete: "cascade" }),
    status: text("status", { enum: VIDEO_STATUSES }).notNull().default("queued"),
    /**
     * Pipeline stage: "tts" and "compose" before rendering, then the
     * HyperFrames progress code (compile, capture, encode, ...). Kept on failure
     * so the UI knows which step failed.
     */
    stage: text("stage"),
    /** 0-100. */
    progress: real("progress").notNull().default(0),
    format: text("format", { enum: VIDEO_FORMATS }).notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    expectedDurationSec: real("expected_duration_sec"),
    /** Duration of the finished MP4, measured with ffprobe. */
    durationSec: real("duration_sec"),
    /** Integrated loudness of the finished MP4 (LUFS), measured after normalizing. */
    loudnessLufs: real("loudness_lufs"),
    /** Storage-relative paths. */
    buildDir: text("build_dir"),
    outputPath: text("output_path"),
    /** Absolute path of the copy the user asked for outside storage (desktop), once it is written. */
    savedPath: text("saved_path"),
    error: text("error"),
    /** Tail of the renderer's output, for debugging failed renders. */
    log: text("log"),
    startedAt: integer("started_at", { mode: "timestamp_ms" }),
    finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
    ...timestamps,
  },
  (t) => [index("videos_project_created_idx").on(t.projectId, t.createdAt)],
);

/** The conversation with the agent that edits a project. */
export const agentMessages = sqliteTable(
  "agent_messages",
  {
    id: id(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["user", "assistant"] }).notNull(),
    text: text("text").notNull().default(""),
    /** What the agent did in this turn (assistant messages). */
    actions: text("actions", { mode: "json" }).$type<AgentActionLog[]>().notNull().default(sql`'[]'`),
    /** Next steps it proposed (assistant messages). */
    suggestions: text("suggestions", { mode: "json" }).$type<AgentSuggestion[]>().notNull().default(sql`'[]'`),
    /** The montage as it was before this turn changed it (assistant messages), so the user can undo the turn. */
    editBefore: text("edit_before", { mode: "json" }).$type<EditDocument>(),
    /** The montage revision this turn left behind: if it differs now, the user has edited since. */
    editRevisionAfter: integer("edit_revision_after"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("agent_messages_project_idx").on(t.projectId, t.createdAt)],
);

export const projectsRelations = relations(projects, ({ many }) => ({
  scenes: many(scenes),
  videos: many(videos),
  agentMessages: many(agentMessages),
}));

export const scenesRelations = relations(scenes, ({ one }) => ({
  project: one(projects, { fields: [scenes.projectId], references: [projects.id] }),
}));

export const videosRelations = relations(videos, ({ one }) => ({
  project: one(projects, { fields: [videos.projectId], references: [projects.id] }),
}));

export const GLOBAL_ASSET_KINDS = ["video", "audio", "image", "document"] as const;
export type GlobalAssetKind = (typeof GLOBAL_ASSET_KINDS)[number];

export const GLOBAL_ASSET_SOURCES = ["upload", "generated", "stock"] as const;
export type GlobalAssetSource = (typeof GLOBAL_ASSET_SOURCES)[number];

/** Global library of assets available across projects: uploaded, generated and stock assets. */
export const globalAssets = sqliteTable(
  "global_assets",
  {
    id: id(),
    name: text("name").notNull(),
    kind: text("kind", { enum: GLOBAL_ASSET_KINDS }).notNull(),
    source: text("source", { enum: GLOBAL_ASSET_SOURCES }).notNull().default("upload"),
    /** Storage-relative path to the file. */
    path: text("path").notNull(),
    duration: real("duration").notNull().default(0),
    width: integer("width").notNull().default(0),
    height: integer("height").notNull().default(0),
    hasAudio: integer("has_audio", { mode: "boolean" }).notNull().default(false),
    context: text("context").notNull().default(""),
    /** Originating project id if created or uploaded within one. */
    projectId: text("project_id"),
    ...timestamps,
  },
  (t) => [
    index("global_assets_created_idx").on(t.createdAt),
    index("global_assets_kind_idx").on(t.kind),
    index("global_assets_source_idx").on(t.source),
    index("global_assets_path_idx").on(t.path),
  ],
);

export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
export type Scene = typeof scenes.$inferSelect;
export type NewScene = typeof scenes.$inferInsert;
export type AgentMessage = typeof agentMessages.$inferSelect;
export type Video = typeof videos.$inferSelect;
export type NewVideo = typeof videos.$inferInsert;
export type GlobalAsset = typeof globalAssets.$inferSelect;
export type NewGlobalAsset = typeof globalAssets.$inferInsert;

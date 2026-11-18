/**
 * Shared domain vocabulary. Pipeline modules and the DB schema both import
 * from here so neither depends on the other.
 */

export const STEP_STATUSES = ["idle", "running", "done", "error"] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

export const VIDEO_FORMATS = ["vertical", "horizontal"] as const;
export type VideoFormat = (typeof VIDEO_FORMATS)[number];

export const FORMAT_SIZE: Record<VideoFormat, { width: number; height: number }> = {
  vertical: { width: 1080, height: 1920 },
  horizontal: { width: 1920, height: 1080 },
};

/**
 * Caption looks: "pop" = 1-3 giant words with a thick outline that pop in,
 * "line" = a line with the spoken word in colour, "box" = a colour box behind the spoken word.
 */
export const CAPTION_STYLES = ["pop", "line", "box"] as const;
export type CaptionStyleId = (typeof CAPTION_STYLES)[number];

/** Transition between scenes: "auto" rotates through the animated ones, "cut" is a hard cut. */
export const TRANSITIONS = ["auto", "cut", "fade", "slide", "zoom"] as const;
export type TransitionId = (typeof TRANSITIONS)[number];

export const TEMPLATE_IDS = ["intro", "text", "bullets", "outro"] as const;
export type TemplateId = (typeof TEMPLATE_IDS)[number];

/** "cancelled" = stopped by the user; not a failure. */
export const VIDEO_STATUSES = ["queued", "composing", "rendering", "done", "error", "cancelled"] as const;
export type VideoStatus = (typeof VIDEO_STATUSES)[number];

/** Where a scene's audio stands. "stale" = text, voice or TTS settings changed since it was made. */
export type AudioStatus = "none" | "ready" | "stale" | "running" | "error";

/** On-screen text of a scene, keyed by its template's field keys. */
export type SceneContent = Record<string, string | string[]>;

export type VisualKind = "video" | "image";

/** One downloadable rendition of a stock asset. */
export interface VisualFile {
  url: string;
  width: number;
  height: number;
  /** Bytes, when the provider reports it. */
  size?: number;
}

/** A b-roll asset found (or generated) by a visual provider. */
export interface VisualCandidate {
  provider: string;
  /** Provider-side id; `provider` + `id` identifies the asset everywhere (cache, dedupe). */
  id: string;
  kind: VisualKind;
  width: number;
  height: number;
  /** Seconds; null for images. */
  durationSec: number | null;
  /** Small remote preview for the picker. */
  thumbUrl: string;
  /** Renditions, smallest first. */
  files: VisualFile[];
  /** Where to credit the asset. */
  pageUrl: string;
  author: string;
  /** 0-1: share of the search words found in the asset's own tags (absent = unknown). */
  relevance?: number;
}

/** One full-screen shot (2-4 s) of a scene: the search behind it and the chosen asset. */
export interface SceneShot {
  query: string;
  selected: VisualCandidate | null;
  /** Alternatives offered in the editor. */
  candidates: VisualCandidate[];
  /** Chosen or searched by hand: automatic runs leave it alone. */
  manual?: boolean;
}

/** What the agent did during a turn, as shown under its reply. */
export interface AgentActionLog {
  tool: string;
  /** Short Spanish description, e.g. "Cambiar el estilo a Impacto". */
  label: string;
  ok: boolean;
  /** What happened (or why it failed). */
  detail?: string;
}

/**
 * A next step the agent proposes: a button that runs `tool` with `input`
 * directly (no model call), or a link.
 */
export interface AgentSuggestion {
  label: string;
  tool?: string;
  input?: Record<string, unknown>;
  href?: string;
}

/** One spoken word, seconds relative to the start of its scene's audio. */
export interface WordTiming {
  id: string;
  text: string;
  start: number;
  end: number;
}

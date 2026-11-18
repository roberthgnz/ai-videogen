import type { CaptionStyleId, StepStatus, TemplateId, TransitionId, VideoFormat } from "@/lib/domain";
import type { PresetId } from "@/presets";
import type { SceneContent } from "@/templates/types";
import type { SceneAudioInfo } from "./scene-audio";
import type { ShotView } from "./scene-shots";
import type { VideoInfo } from "./video-panel";

/** Serializable view of a project for the studio and the result page. */
export interface EditorProject {
  edit: import("@/lib/editing/schema").EditDocument;
  id: string;
  title: string;
  topic: string;
  targetDurationSec: number;
  tone: string;
  format: VideoFormat;
  voiceId: string | null;
  preset: PresetId;
  captionStyle: CaptionStyleId;
  transition: TransitionId;
  /** "auto", "none" or a file name in storage/music. */
  music: string;
  sfx: boolean;
  /** What is in storage/music and storage/sfx right now. */
  audioLibrary: { music: string[]; sfx: number };
  scriptStatus: StepStatus;
  scriptError: string | null;
  scenes: { id: string; template: TemplateId; narration: string; content: SceneContent; visualQueries: string[] }[];
  /** B-roll shots per saved scene id. Read from props, like the audio. */
  shots: Record<string, ShotView[]>;
  /** Whether a b-roll provider is configured, and how to credit its results. */
  visuals: { available: boolean; credit: { label: string; url: string } | null };
  /** Audio state per saved scene id. Read from props so live refreshes don't touch edits. */
  audio: Record<string, SceneAudioInfo>;
  /** Full-video versions, newest first. */
  videos: VideoInfo[];
  /** Latest single-scene preview per scene id. */
  previews: Record<string, VideoInfo>;
  /** Editing in passes and the saved versions of the montage. */
  passes: import("@/lib/editing/passes-shared").PassesView;
}

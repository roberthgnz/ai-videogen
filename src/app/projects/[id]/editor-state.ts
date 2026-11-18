import type { TemplateId } from "@/lib/domain";
import { MAX_VISUAL_QUERIES, MAX_VISUAL_QUERY_CHARS } from "@/lib/script/schema";
import type { SceneContent } from "@/templates/types";
import type { ShotView } from "./scene-shots";
import type { EditorProject } from "./types";

/** A scene as the studio edits it. `key` is React-only; `id` is missing until it is saved. */
export interface SceneState {
  key: string;
  id?: string;
  template: TemplateId;
  narration: string;
  content: SceneContent;
  /** B-roll searches as typed: comma-separated, English. */
  visualQueries: string;
}

export type Settings = Pick<
  EditorProject,
  "topic" | "targetDurationSec" | "tone" | "format" | "voiceId" | "preset" | "captionStyle" | "transition" | "music" | "sfx"
>;

export function initialEditorState(project: EditorProject) {
  return {
    settings: {
      topic: project.topic,
      targetDurationSec: project.targetDurationSec,
      tone: project.tone,
      format: project.format,
      voiceId: project.voiceId,
      preset: project.preset,
      captionStyle: project.captionStyle,
      transition: project.transition,
      music: project.music,
      sfx: project.sfx,
    } satisfies Settings,
    title: project.title,
    scenes: project.scenes.map<SceneState>((s) => ({ key: s.id, ...s, visualQueries: s.visualQueries.join(", ") })),
  };
}

/** Drops the React-only key before sending/comparing a scene. */
export function toEditable(scene: SceneState) {
  return {
    id: scene.id,
    template: scene.template,
    narration: scene.narration,
    content: scene.content,
    visualQueries: scene.visualQueries
      .split(",")
      .map((q) => q.trim().slice(0, MAX_VISUAL_QUERY_CHARS))
      .filter(Boolean)
      .slice(0, MAX_VISUAL_QUERIES),
  };
}

export function snapshot(state: { settings: Settings; title: string; scenes: SceneState[] }): string {
  return JSON.stringify({ settings: state.settings, title: state.title, scenes: state.scenes.map(toEditable) });
}

/** Thumbnails of a scene's chosen b-roll, in shot order. */
export function sceneThumbs(shots: ShotView[] | undefined): string[] {
  return (shots ?? []).flatMap((shot) => {
    const url = shot.candidates.find((c) => c.key === shot.selectedKey)?.thumbUrl;
    return url ? [url] : [];
  });
}

/** The on-screen text of a scene as a flat list of strings. */
export function onScreenText(content: SceneContent): string[] {
  return Object.values(content)
    .flat()
    .filter((v): v is string => typeof v === "string" && v.trim() !== "");
}

import type { SceneContent, WordTiming } from "@/lib/domain";
import type { Layout } from "@/lib/pipeline/composition/layout";
import type { TemplateVars } from "@/lib/pipeline/composition/html";
import type { Theme } from "@/theme";

/** Everything a template needs to fill its scene.html. Times are scene-local seconds. */
export interface SceneContext {
  /** Composition id, e.g. "scene-2" (host id = root data-composition-id = timeline key). */
  id: string;
  /** Prefix for element ids, unique across the assembled page, e.g. "s2". */
  prefix: string;
  index: number;
  isLast: boolean;
  /** Scene length (lead + audio + tail). */
  duration: number;
  /** When the narration starts inside the scene. */
  narrationStart: number;
  /** Narration word timings relative to the audio start (add narrationStart for scene time). */
  words: WordTiming[];
  content: SceneContent;
  layout: Layout;
  theme: Theme;
}

/**
 * Template-specific values for scene.html. The composer adds the shared ones:
 * id, prefix, width, height, duration, baseCss, background, backgroundCss,
 * backgroundTweens, exitTween.
 */
export type SceneComposer = (ctx: SceneContext) => TemplateVars;

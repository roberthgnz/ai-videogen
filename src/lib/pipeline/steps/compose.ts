import { t as translate } from "@/lib/i18n";
import type { CaptionStyleId, VideoFormat } from "@/lib/domain";
import { getProject } from "@/lib/projects";
import { resolveInStorage } from "@/lib/storage";
import { themeForPreset } from "@/presets";
import { planEditComposition } from "@/lib/editing/composition";
import { planComposition, writeComposition, type CompositionPlan } from "../composition";
import { PipelineError } from "../errors";
import { getCachedTts, type CachedTts } from "../tts";
import { shotFilePath } from "../visuals/media";
import { expectedAudioHashes, sceneAudioStatus } from "./tts";
import { readyShots } from "./visuals";

/**
 * Composition step for a project: requires up-to-date audio for every scene,
 * then writes the HyperFrames project to `outDir`.
 */
export function composeProject(
  projectId: string,
  outDir: string,
  options: {
    source?: "script" | "montage";
    format?: VideoFormat;
    captionStyle?: CaptionStyleId;
    tts?: CachedTts;
    sceneIds?: string[];
    /** Prepared music file and effect files (see steps/video.ts). */
    music?: string;
    sfx?: string[];
    editSnapshot?: import("@/lib/editing/schema").EditDocument;
  } = {},
): CompositionPlan {
  const project = getProject(projectId);
  if (!project) throw new PipelineError("composition", translate("Project not found."));
  if ((options.editSnapshot || (options.source !== "script" && project.edit.enabled)) && !options.sceneIds) {
    const plan = planEditComposition(options.editSnapshot ?? project.edit, options.format ?? project.format, project.title || project.topic);
    writeComposition(plan, outDir);
    return plan;
  }
  const scenes = options.sceneIds ? project.scenes.filter((s) => options.sceneIds!.includes(s.id)) : project.scenes;
  if (scenes.length === 0) throw new PipelineError("composition", translate("There are no scenes to compose."));

  const hashes = expectedAudioHashes(scenes, project.voiceId, options.tts ?? getCachedTts());
  const missing = scenes
    .map((s) => ({ i: project.scenes.indexOf(s), status: sceneAudioStatus(s, hashes[s.id]) }))
    .filter((x) => x.status !== "ready");
  if (missing.length) {
    throw new PipelineError(
      "composition",
      translate("It lacks audio a day in: {0}. It generates the voice first.", missing.map((m) => translate("scene {0} ({1})", m.i + 1, m.status)).join(", ")),
    );
  }

  const format = options.format ?? project.format;
  const plan = planComposition({
    title: project.title || project.topic,
    format,
    captionStyle: options.captionStyle ?? project.captionStyle,
    // A single-scene preview has nothing to transition to.
    transition: project.transition,
    theme: themeForPreset(project.preset),
    music: options.music,
    sfx: options.sfx,
    scenes: scenes.map((s) => ({
      // Only assets already downloaded for this format; without any, the scene keeps the gradient.
      shots: readyShots(s, format).map((c) => ({ file: shotFilePath(c, format), kind: c.kind })),
      template: s.template,
      content: s.content,
      words: s.words ?? [],
      audioFile: resolveInStorage(s.audioPath!),
      audioDurationSec: s.audioDurationSec!,
    })),
  });
  writeComposition(plan, outDir);
  return plan;
}

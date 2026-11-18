import { t as translate } from "@/lib/i18n";
import { FORMAT_SIZE } from "@/lib/domain";
import { createVideo, getProject } from "@/lib/projects";
import { runScriptStep } from "./script";
import { startVideo, type StartVideoOptions } from "./video";
import type { ScriptGenerator } from "../script";

// One-click jobs still writing their script in this process (survives dev hot reloads).
const globalForOneClick = globalThis as unknown as { __videogenOneClick?: Set<string> };
const running = (globalForOneClick.__videogenOneClick ??= new Set());

export function isOneClickActive(projectId: string): boolean {
  return running.has(projectId);
}

/**
 * Topic -> finished video with the project's current settings, in the
 * background: script first, then the usual video job (voice, b-roll,
 * composition, render). Every step records its own status and error, so the
 * result page shows where it is and what failed.
 */
export function startOneClick(
  projectId: string,
  options: { generator?: ScriptGenerator; video?: StartVideoOptions } = {},
): { ok: true } | { ok: false; error: string } {
  const project = getProject(projectId);
  if (!project) return { ok: false, error: translate("Project not found.") };
  if (!project.topic.trim()) return { ok: false, error: translate("Write a theme for the video.") };
  if (!project.voiceId) return { ok: false, error: translate("Choose a voice before you generate the video.") };
  if (running.has(projectId)) return { ok: false, error: translate("This video is already being generated.") };

  running.add(projectId);
  void (async () => {
    const script = await runScriptStep(projectId, options.generator);
    if (!script.ok) return; // The script step stored its error on the project.
    const video = startVideo(projectId, options.video);
    if (!video.ok) {
      // e.g. another render is running: leave a failed version that says why.
      const { width, height } = FORMAT_SIZE[project.format];
      createVideo({
        projectId,
        format: project.format,
        width,
        height,
        status: "error",
        stage: "tts",
        error: video.error,
        startedAt: new Date(),
        finishedAt: new Date(),
      });
    }
  })()
    .catch((error) => console.error(`[oneclick] project ${projectId}:`, error))
    .finally(() => running.delete(projectId));
  return { ok: true };
}

"use server";

import { t as translate } from "@/lib/i18n";
import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { runScriptStep } from "@/lib/pipeline/steps/script";
import { startTtsForProject, startTtsForScene } from "@/lib/pipeline/steps/tts";
import { cancelVideo, isRenderActive, startVideo } from "@/lib/pipeline/steps/video";
import { pickShot, runVisualsForProject, searchShot } from "@/lib/pipeline/steps/visuals";
import { storagePaths } from "@/lib/storage";
import fs from "node:fs";
import path from "node:path";
import { getAppSettings, saveAppSettings } from "@/lib/app-settings";
import { VIDEO_FORMATS } from "@/lib/domain";
import { deleteProject, getProject, getScene, projectSettingsSchema, saveScript, updateProjectSettings } from "@/lib/projects";
import { releaseProjectAssets } from "@/lib/global-assets";
import { editableScriptIssues, editableScriptSchema } from "@/lib/script/schema";

// Local single-user app (bound to 127.0.0.1): no auth checks by design.

export type ActionResult =
  | { ok: true }
  | { ok: false; error: string; sceneIssues?: Record<number, string[]> };

function zodSummary(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
}

/** Saves settings and the edited script in one go. */
export async function saveProjectAction(
  projectId: string,
  input: { settings: unknown; script: unknown },
): Promise<ActionResult> {
  if (!getProject(projectId)) return { ok: false, error: translate("Project not found.") };

  const settings = projectSettingsSchema.safeParse(input.settings);
  if (!settings.success) return { ok: false, error: translate("Unvalid adjustments: {0}", zodSummary(settings.error)) };

  const script = editableScriptSchema.safeParse(input.script);
  if (!script.success) return { ok: false, error: translate("Invalid script: {0}", zodSummary(script.error)) };

  const sceneIssues = editableScriptIssues(script.data);
  if (Object.keys(sceneIssues).length) {
    return { ok: false, error: translate("There are scenes with mistakes, run them before you save."), sceneIssues };
  }

  updateProjectSettings(projectId, settings.data);
  saveScript(projectId, script.data);
  refresh();
  return { ok: true };
}

/** Saves settings, then (re)generates the whole script with the LLM. */
export async function saveGenerationSettingsAction(projectId: string, input: unknown): Promise<ActionResult> {
  if (!getProject(projectId)) return { ok: false, error: translate("Project not found.") };
  const settings = projectSettingsSchema.safeParse(input);
  if (!settings.success) return { ok: false, error: translate("Unvalid adjustments: {0}", zodSummary(settings.error)) };
  updateProjectSettings(projectId, settings.data);
  refresh();
  return { ok: true };
}

export async function generateScriptAction(projectId: string, settingsInput: unknown): Promise<ActionResult> {
  if (!getProject(projectId)) return { ok: false, error: translate("Project not found.") };

  const settings = projectSettingsSchema.safeParse(settingsInput);
  if (!settings.success) return { ok: false, error: translate("Unvalid adjustments: {0}", zodSummary(settings.error)) };
  if (!settings.data.topic.trim()) return { ok: false, error: translate("Write a theme before you generate the script.") };

  updateProjectSettings(projectId, settings.data);
  const result = await runScriptStep(projectId);
  refresh();
  return result;
}

/**
 * Queues audio for every scene without up-to-date audio (cached audio is free)
 * and returns at once; the page polls scene statuses for progress.
 */
export async function generateVoiceAction(projectId: string): Promise<ActionResult> {
  const result = startTtsForProject(projectId);
  refresh();
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}

/** Queues one scene's audio. `force` = new take even if the text is unchanged. */
export async function sceneAudioAction(projectId: string, sceneId: string, force: boolean): Promise<ActionResult> {
  const scene = getScene(sceneId);
  if (!scene || scene.projectId !== projectId) return { ok: false, error: translate("Scene not found.") };
  const result = startTtsForScene(sceneId, { force });
  refresh();
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}

/**
 * Searches b-roll for every shot (hand-picked shots are kept). Files are only
 * downloaded when the video is generated. `refresh` replaces current picks.
 */
export async function findVisualsAction(projectId: string, refreshPicks = false): Promise<ActionResult> {
  const result = await runVisualsForProject(projectId, { refresh: refreshPicks === true });
  refresh();
  if (!result.ok) return { ok: false, error: result.error };
  if (result.skipped) return { ok: false, error: translate("PIXABAY_API_KEY is missing in .env.local to search b-roll.") };
  return { ok: true };
}

async function ownScene(projectId: string, sceneId: string) {
  const scene = getScene(sceneId);
  return scene && scene.projectId === projectId ? scene : null;
}

/** New search for one shot of a scene. */
export async function searchShotAction(projectId: string, sceneId: string, index: number, query: string): Promise<ActionResult> {
  if (!(await ownScene(projectId, sceneId))) return { ok: false, error: translate("Scene not found.") };
  if (!Number.isInteger(index) || typeof query !== "string" || query.length > 100) return { ok: false, error: translate("Search invalid.") };
  const result = await searchShot(sceneId, index, query);
  refresh();
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}

/** Uses one of a shot's candidates. */
export async function pickShotAction(projectId: string, sceneId: string, index: number, candidateKey: string): Promise<ActionResult> {
  if (!(await ownScene(projectId, sceneId))) return { ok: false, error: translate("Scene not found.") };
  if (!Number.isInteger(index) || typeof candidateKey !== "string") return { ok: false, error: translate("No plan valid.") };
  const result = pickShot(sceneId, index, candidateKey);
  refresh();
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}

const renderInput = z.object({
  source: z.enum(["script", "montage"]).optional(),
  format: z.enum(VIDEO_FORMATS).optional(),
  quality: z.enum(["draft", "looks", "delivery"]).optional(),
  /** Render only this scene (preview). */
  sceneId: z.string().optional(),
  /** Desktop only: absolute path of an .mp4, picked in the system dialog, to copy the finished video to. */
  saveTo: z.string().max(1024).optional(),
  /** The system dialog already asked the user to replace the file at `saveTo`. */
  overwrite: z.boolean().optional(),
});

/** Starts voice (if missing) -> composition -> render in the background. */
export async function startVideoAction(
  projectId: string,
  input: unknown,
): Promise<ActionResult | { ok: true; videoId: string }> {
  const parsed = renderInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: translate("Unvalid options: {0}", zodSummary(parsed.error)) };
  const { saveTo } = parsed.data;
  if (saveTo !== undefined) {
    // The server writes there itself: only where it runs on the user's own computer.
    if (process.env.VIDEOGEN_DESKTOP !== "1") return { ok: false, error: translate("Choose where to save the video only works on the desktop app.") };
    if (!path.isAbsolute(saveTo) || path.extname(saveTo).toLowerCase() !== ".mp4" || saveTo.includes("\0")) {
      return { ok: false, error: translate("Choose a .mp4 file from a folder on your computer.") };
    }
  }
  const result = startVideo(projectId, parsed.data);
  // The next export offers the same folder.
  if (result.ok && saveTo) saveAppSettings({ ...getAppSettings(), exportFolder: path.dirname(saveTo) });
  refresh();
  return result.ok ? { ok: true, videoId: result.videoId } : { ok: false, error: result.error };
}

/**
 * Deletes the project, its scenes, versions and files (the shared TTS cache stays). Its library files are kept
 * unless `removeLibraryAssets` takes them out of the library too.
 */
export async function deleteProjectAction(projectId: string, removeLibraryAssets = false): Promise<ActionResult> {
  const project = getProject(projectId);
  if (!project) return { ok: false, error: translate("Project not found.") };
  if (project.videos.some((v) => isRenderActive(v.id))) {
    return { ok: false, error: translate("There is a current render in this project; cancel it before deleting.") };
  }
  await releaseProjectAssets(projectId, removeLibraryAssets === true);
  deleteProject(projectId);
  fs.rmSync(storagePaths.project(projectId), { recursive: true, force: true });
  redirect("/");
}

export async function cancelVideoAction(videoId: string): Promise<ActionResult> {
  cancelVideo(videoId);
  refresh();
  return { ok: true };
}

"use server";

import { t as translate } from "@/lib/i18n";
import fs from "node:fs/promises";
import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { isAgentBusy, startAgentTurn } from "@/lib/agent/run";
import { VIDEO_FORMATS, type VideoFormat } from "@/lib/domain";
import { isRenderActive } from "@/lib/pipeline/steps/video";
import { createProject, deleteProject, getProject, MAX_TITLE_CHARS, MAX_TOPIC_CHARS, renameProject } from "@/lib/projects";
import { storagePaths } from "@/lib/storage";
import { z } from "zod";
import { attachItemSchema, attachReferences, listReusableReferences, type ReusableReference } from "@/lib/editing/reference-library";
import { DEFAULT_PRESET, PRESET_IDS, STYLE_PRESETS, type PresetId } from "@/presets";
import { emptyEditDocument } from "@/lib/editing/schema";
import { getAppSettings } from "@/lib/app-settings";
import { getGlobalAsset, importGlobalAssetToProject, listGlobalAssets, releaseProjectAssets, syncExistingAssetsToGlobal } from "@/lib/global-assets";
import type { GlobalAssetSource } from "@/lib/db/schema";
import { warmOverview } from "@/lib/editing/overview";
import { warmFootage } from "@/lib/editing/footage";

// Local single-user app (bound to 127.0.0.1): no auth checks by design.

export interface CreateProjectState {
  error: string | null;
  topic: string;
}

/** What the agent is told about a message typed on the home screen (its prompt makes it write and render in one go). */
const HOME_ORIGIN = "From the home screen";

/**
 * Creates a project from what was typed on the home page and hands it to the
 * agent, which writes the script and generates the video; the studio opens
 * right away and shows it working. Nothing is stored until there is a topic,
 * so abandoned "new video" clicks leave no empty rows.
 */
export async function createProjectAction(_prev: CreateProjectState, formData: FormData): Promise<CreateProjectState> {
  const raw = formData.get("topic");
  const topic = typeof raw === "string" ? raw.trim() : "";
  if (topic.length > MAX_TOPIC_CHARS) {
    return { error: translate("The text cannot go from {0} characters.", MAX_TOPIC_CHARS), topic };
  }
  const workspace = formData.get("workspace");
  if (workspace === "blank" || workspace === "import") {
    const format = formData.get("format") === "horizontal" ? "horizontal" : "vertical";
    const { defaults } = getAppSettings();
    const project = createProject({ title: workspace === "import" ? translate("Edit video") : translate("New edit"), topic, format, preset: defaults.preset, targetDurationSec: defaults.targetDurationSec, tone: defaults.tone, sfx: defaults.sfx, edit: { ...emptyEditDocument(), enabled: true }, music: "none" });
    redirect(`/projects/${project.id}`);
  }
  if (!topic) return { error: translate("Describe the video you want to create."), topic: "" };
  const project = newVideoProject(topic, formData.get("preset"), formData.get("format"));

  // If the agent cannot start (e.g. a missing key), the studio still opens: the error shows in its conversation.
  startAgentTurn(project.id, topic, { origin: HOME_ORIGIN });
  redirect(`/projects/${project.id}`);
}

/** A project for a video the agent writes from a topic, in the chosen style and format. */
function newVideoProject(topic: string, presetRaw: unknown, formatRaw: unknown) {
  const preset: PresetId = PRESET_IDS.includes(presetRaw as PresetId) ? (presetRaw as PresetId) : DEFAULT_PRESET;
  const format: VideoFormat = VIDEO_FORMATS.includes(formatRaw as VideoFormat) ? (formatRaw as VideoFormat) : "vertical";
  const style = STYLE_PRESETS[preset];
  const { defaults } = getAppSettings();
  return createProject({ topic, preset, format, captionStyle: style.captionStyle, transition: style.transition, targetDurationSec: defaults.targetDurationSec, tone: defaults.tone, music: defaults.music, sfx: defaults.sfx });
}

/**
 * The first step of creating a video with references from the home page: the project, without
 * starting the agent, so the references can be added before it reads the project. The composer then
 * calls attachReferencesAction and startHomeAgentAction.
 */
export async function createVideoProjectAction(input: { topic: string; preset: string; format: string }): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const topic = typeof input?.topic === "string" ? input.topic.trim() : "";
  if (!topic) return { ok: false, error: translate("Describe the video you want to create.") };
  if (topic.length > MAX_TOPIC_CHARS) return { ok: false, error: translate("The text cannot go from {0} characters.", MAX_TOPIC_CHARS) };
  return { ok: true, id: newVideoProject(topic, input.preset, input.format).id };
}

/** References saved in any project, to reuse from the home composer. */
export async function listReferenceLibraryAction(): Promise<ReusableReference[]> {
  return listReusableReferences();
}

/** Adds the composer's references to a new project (files already uploaded, written ones, copies of existing ones). */
export async function attachReferencesAction(projectId: string, items: unknown, mode: "create" | "edit"): Promise<{ error: string | null; skipped: string[] }> {
  const parsed = z.array(attachItemSchema).max(40).safeParse(items);
  if (typeof projectId !== "string" || !parsed.success) return { error: translate("Invalid references."), skipped: [] };
  try {
    const { skipped } = await attachReferences(projectId, parsed.data, { montage: mode === "edit" });
    return { error: null, skipped };
  } catch (e) {
    return { error: e instanceof Error ? e.message : translate("The references could not be added."), skipped: [] };
  }
}

/** A file of the library the home composer can put in a new project: video, image or music (documents stay out). */
export interface LibraryItem {
  id: string;
  name: string;
  kind: "video" | "image" | "audio";
  source: GlobalAssetSource;
  duration: number;
  /** Cover for videos and images. */
  thumbnail: string | null;
}

/** The library, newest first, for the composer's "use from my library" picker. */
export async function listLibraryAction(): Promise<LibraryItem[]> {
  // Pick up what projects made since the last look (renders, voices, stock, uploads), as the library page does.
  try { syncExistingAssetsToGlobal(); } catch { /* the list still shows what is indexed */ }
  return listGlobalAssets().flatMap((a) => a.kind === "document" ? [] : [{
    id: a.id, name: a.name, kind: a.kind, source: a.source, duration: a.duration,
    thumbnail: a.kind === "audio" ? null : `/api/media/global/${a.id}/thumbnail`,
  }]);
}

/**
 * Puts a library file in the composer's new project, on the timeline like an uploaded one (sharing the
 * library's file, nothing is copied). Without a project yet it creates it from this file, named after it and
 * in its orientation, as the first upload does.
 */
export async function importLibraryAssetAction(projectId: string | null, assetId: string): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  if ((projectId !== null && typeof projectId !== "string") || typeof assetId !== "string") return { ok: false, error: translate("Request invalid.") };
  const asset = getGlobalAsset(assetId);
  if (!asset || asset.kind === "document") return { ok: false, error: translate("It's not in your library anymore.") };
  if (projectId && !getProject(projectId)) return { ok: false, error: translate("Project not found.") };
  if (!projectId && asset.kind === "audio") return { ok: false, error: translate("It starts with a video or an image: audio is only used as music.") };
  const title = asset.name.replace(/\.[^.]+$/, "").slice(0, 80).trim() || translate("My video");
  const id = projectId ?? createProject({ title, format: asset.width > asset.height ? "horizontal" : "vertical", edit: { ...emptyEditDocument(), enabled: true }, music: "none" }).id;
  try {
    const edit = importGlobalAssetToProject(id, assetId, { place: true });
    // Prepare what the assistant reads about the footage, as an upload does.
    const placed = edit.assets.find((a) => a.path === asset.path);
    if (placed) { warmOverview(id, placed); warmFootage(id, placed); }
    return { ok: true, id };
  } catch (e) {
    if (!projectId) {
      deleteProject(id);
      await fs.rm(storagePaths.project(id), { recursive: true, force: true }).catch(() => {});
    }
    return { ok: false, error: e instanceof Error ? e.message : translate("It couldn't be added.") };
  }
}

/** What the agent is told when the home message comes with the user's own files (already on the timeline). */
const HOME_IMPORT_ORIGIN = "From the start screen, on the files the user has just added";

/**
 * Hands the instruction typed alongside the imported files to the agent, once
 * they are all in the project. If it cannot start, the editor still opens and
 * the error shows in its conversation.
 */
export async function startImportAgentAction(projectId: string, text: string): Promise<{ error: string | null }> {
  return startHomeAgentAction(projectId, text, "edit");
}

/**
 * Starts the agent on a project made from the home composer: "create" writes and generates the video
 * from the topic, "edit" works on the files the user uploaded. The references already in the project
 * are part of the state it reads. With nothing typed there is nothing to start.
 */
export async function startHomeAgentAction(projectId: string, text: string, mode: "create" | "edit"): Promise<{ error: string | null }> {
  if (typeof projectId !== "string" || typeof text !== "string" || (mode !== "create" && mode !== "edit")) return { error: translate("Request invalid.") };
  const message = text.trim();
  if (!message) return { error: null };
  if (message.length > MAX_TOPIC_CHARS) return { error: translate("The text cannot go from {0} characters.", MAX_TOPIC_CHARS) };
  const references = getProject(projectId)?.edit.references.length ?? 0;
  const base = mode === "create" ? HOME_ORIGIN : HOME_IMPORT_ORIGIN;
  const origin = references ? translate("{0}, with {1} reference {2} attached {3}: follow them according to their roles", base, references, references === 1 ? "" : "s", references === 1 ? "" : "s") : base;
  const result = startAgentTurn(projectId, message, { origin });
  return { error: result.ok ? null : result.error };
}

export type ProjectCardResult = { ok: true } | { ok: false; error: string };

/** Renames a project from its card on the home page. */
export async function renameProjectAction(projectId: string, title: string): Promise<ProjectCardResult> {
  if (typeof projectId !== "string" || typeof title !== "string") return { ok: false, error: translate("Request invalid.") };
  const clean = title.trim();
  if (!clean) return { ok: false, error: translate("Write a name.") };
  if (clean.length > MAX_TITLE_CHARS) return { ok: false, error: translate("The name cannot go from {0} characters.", MAX_TITLE_CHARS) };
  if (!getProject(projectId)) return { ok: false, error: translate("Project not found.") };
  renameProject(projectId, clean);
  refresh();
  return { ok: true };
}

/**
 * Deletes a project from its card on the home page: its scenes, versions and
 * files (the shared TTS cache stays). Its library files are kept (moved out of its folder) unless
 * `removeLibraryAssets` asks to take them out of the library too. Refuses while something is still working on it.
 */
export async function deleteProjectFromHomeAction(projectId: string, removeLibraryAssets = false): Promise<ProjectCardResult> {
  if (typeof projectId !== "string" || typeof removeLibraryAssets !== "boolean") return { ok: false, error: translate("Request invalid.") };
  const project = getProject(projectId);
  if (!project) return { ok: false, error: translate("Project not found.") };
  if (project.videos.some((v) => isRenderActive(v.id))) return { ok: false, error: translate("There is a current render in this project; cancel it before deleting.") };
  if (isAgentBusy(projectId)) return { ok: false, error: translate("The assistant is working on this project; wait for it to be over.") };
  await releaseProjectAssets(projectId, removeLibraryAssets);
  deleteProject(projectId);
  await fs.rm(storagePaths.project(projectId), { recursive: true, force: true });
  refresh();
  return { ok: true };
}

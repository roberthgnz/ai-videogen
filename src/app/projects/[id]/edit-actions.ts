"use server";

import { t as translate } from "@/lib/i18n";
import fs from "node:fs/promises";
import path from "node:path";
import { refresh } from "next/cache";
import { z } from "zod";
import { storagePaths } from "@/lib/storage";
import { isAgentBusy } from "@/lib/agent/run";
import { getProject } from "@/lib/projects";
import { editDetailsSchema, saveEditDocument } from "@/lib/editing/repository";
import type { EditAsset, EditDocument } from "@/lib/editing/schema";
import { getGlobalAsset, importGlobalAssetToProject } from "@/lib/global-assets";

/**
 * What the user reads when one of these actions fails. A montage the schema rejects comes as a list of
 * issues whose message is that list as JSON: the user gets the sentences this app wrote for them (the
 * schema's own checks are in English and name fields), or a plain one with what to do next.
 */
function errorText(e: unknown, fallback: string): string {
  if (e instanceof z.ZodError) {
    const written = [...new Set(e.issues.filter((issue) => issue.code === "custom").map((issue) => issue.message))];
    return written.slice(0, 2).join(" ") || translate("There is a data of the assembly that is not valid. Undo the last change and try again.");
  }
  return e instanceof Error ? e.message : fallback;
}

export async function saveEditAction(projectId: string, input: unknown, details?: unknown): Promise<{ ok: true; edit: EditDocument } | { ok: false; error: string }> {
  try {
    if (isAgentBusy(projectId)) throw new Error(translate("Wait till the agent's done before he's saved."));
    const edit = saveEditDocument(projectId, input, false, details === undefined ? undefined : editDetailsSchema.parse(details));
    refresh();
    return { ok: true, edit };
  } catch (e) {
    return { ok: false, error: errorText(e, translate("You couldn't save the assembly.")) };
  }
}

export async function loadRenderedVideoAction(projectId: string) {
  try {
    const p = getProject(projectId);
    if (!p) throw new Error(translate("Project not found."));
    if (isAgentBusy(projectId)) throw new Error(translate("Wait till the agent's done."));
    const video = p.videos.find((v) => !v.sceneId && v.status === "done" && v.outputPath);
    if (!video?.outputPath || !video.durationSec) throw new Error(translate("It generates a video first or it matters one of your files."));
    const existing = p.edit.assets.find((asset) => asset.path === video.outputPath);
    if (existing && p.edit.clips.some((clip) => clip.assetId === existing.id)) return { ok: true as const, edit: p.edit };
    const id = crypto.randomUUID();
    const edit = saveEditDocument(projectId, { ...p.edit, enabled: true, duration: video.durationSec,
      assets: existing ? p.edit.assets : [...p.edit.assets, { id, name: p.title || translate("Video generated"), path: video.outputPath, kind: "video", duration: video.durationSec, width: video.width, height: video.height, hasAudio: true, context: translate("Video generated in this project.") }],
      clips: [...p.edit.clips, { id: crypto.randomUUID(), assetId: existing?.id ?? id, start: 0, in: 0, duration: video.durationSec, volume: 1, fit: "contain" }],
    }, true);
    refresh();
    return { ok: true as const, edit };
  } catch (e) { return { ok: false as const, error: errorText(e, translate("You couldn't load the video.")) }; }
}

/**
 * Takes a file out of the project: its entry in the library and its folder on disk. Refuses while the
 * file is on the timeline or guides the agent as a reference, so nothing in the montage loses its media.
 */
export async function removeAssetAction(projectId: string, assetId: string): Promise<{ ok: true; edit: EditDocument } | { ok: false; error: string }> {
  try {
    if (typeof assetId !== "string" || !/^[\w-]{8,64}$/.test(assetId)) throw new Error(translate("Invalid file."));
    if (isAgentBusy(projectId)) throw new Error(translate("Wait till the agent's done."));
    const p = getProject(projectId);
    if (!p) throw new Error(translate("Project not found."));
    const asset = p.edit.assets.find((a) => a.id === assetId);
    if (!asset) throw new Error(translate("That file is no longer in the library."));
    if (p.edit.clips.some((c) => c.assetId === assetId)) throw new Error(translate("He's on the timeline, get him out of there first."));
    if (p.edit.references.some((r) => r.assetId === assetId)) throw new Error(translate("It's a reference: remove it in References first."));
    const edit = saveEditDocument(projectId, { ...p.edit, assets: p.edit.assets.filter((a) => a.id !== assetId) }, true);
    // Only the folder the import created for this file, never anything outside the project.
    const dir = path.join(storagePaths.project(projectId), "media", assetId);
    if (path.relative(storagePaths.project(projectId), dir).startsWith("media")) await fs.rm(dir, { recursive: true, force: true });
    refresh();
    return { ok: true, edit };
  } catch (e) {
    return { ok: false, error: errorText(e, translate("You couldn't remove the file.")) };
  }
}

export async function addGlobalAssetToProjectAction(projectId: string, globalAssetId: string): Promise<{ ok: true; edit: EditDocument; asset: EditAsset } | { ok: false; error: string }> {
  try {
    if (isAgentBusy(projectId)) throw new Error(translate("Wait till the agent's done."));
    const globalAsset = getGlobalAsset(globalAssetId);
    if (!globalAsset) throw new Error("Asset global no encontrado.");
    const edit = importGlobalAssetToProject(projectId, globalAssetId);
    const asset = edit.assets.find((a) => a.path === globalAsset.path) || edit.assets.at(-1)!;
    refresh();
    return { ok: true, edit, asset };
  } catch (e) {
    return { ok: false, error: errorText(e, translate("The asset could not be added to the project.")) };
  }
}

import { t as translate } from "@/lib/i18n";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { getProject, listProjects } from "@/lib/projects";
import { ensureDir, resolveInStorage, storagePaths, toStorageRelative } from "@/lib/storage";
import { warmOverview } from "./overview";
import { fileReference } from "./references";
import { saveEditDocument } from "./repository";
import { REFERENCE_ROLES, type EditAsset, type EditDocument, type EditReference } from "./schema";
import { thumbnailUrl } from "./timeline";

/** A reference saved in some project, offered to reuse in a new one. */
export interface ReusableReference {
  projectId: string;
  projectTitle: string;
  referenceId: string;
  title: string;
  roles: EditReference["roles"];
  /** What it is: one of the file kinds, or "text" for a written reference (with or without a link). */
  kind: EditAsset["kind"] | "text";
  thumbnail: string | null;
  duration: number;
  /** The first words of its text, to recognise it. */
  excerpt: string;
}

/** Every reference of every project, newest project first: the library the home composer picks from. */
export function listReusableReferences(limit = 200): ReusableReference[] {
  const out: ReusableReference[] = [];
  for (const p of listProjects()) {
    for (const r of p.edit.references) {
      const asset = r.assetId ? p.edit.assets.find((a) => a.id === r.assetId) : undefined;
      if (r.assetId && !asset) continue;
      out.push({
        projectId: p.id, projectTitle: p.title || p.topic || translate("Untitled"), referenceId: r.id, title: r.title, roles: r.roles,
        kind: asset?.kind ?? "text",
        thumbnail: asset && (asset.kind === "video" || asset.kind === "image") ? thumbnailUrl(p.id, asset) : null,
        duration: asset?.duration ?? 0,
        excerpt: (r.content || asset?.context || r.url).replace(/\s+/g, " ").trim().slice(0, 140),
      });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

const roles = z.array(z.enum(REFERENCE_ROLES)).min(1).max(REFERENCE_ROLES.length);
/** What the composer sends to attach to a new project. */
export const attachItemSchema = z.discriminatedUnion("source", [
  /** A file already uploaded to this project (it is one of its assets). */
  z.object({ source: z.literal("file"), assetId: z.string().min(1).max(80), roles }),
  /** Written in the composer: text, a link or both. */
  z.object({ source: z.literal("text"), title: z.string().trim().min(1).max(160), content: z.string().max(16000), url: z.union([z.literal(""), z.url().refine((v) => /^https?:\/\//.test(v))]), roles }),
  /** A reference of another project, copied with its file. */
  z.object({ source: z.literal("existing"), projectId: z.string().min(1).max(80), referenceId: z.string().min(1).max(80), roles }),
]);
export type AttachItem = z.infer<typeof attachItemSchema>;

/**
 * Copies a file of another project into this one under a new id (the processed media is reused as is,
 * nothing is re-encoded), so deleting either project never breaks the other's reference.
 */
async function copyAsset(targetId: string, asset: EditAsset): Promise<EditAsset> {
  const id = crypto.randomUUID();
  const source = resolveInStorage(asset.path);
  const dir = ensureDir(path.join(storagePaths.project(targetId), "media", id));
  const target = path.join(dir, path.basename(source));
  try {
    await fs.copyFile(source, target);
  } catch (error) {
    // Only the folder made above, for this new id, is removed.
    await fs.rm(dir, { recursive: true, force: true });
    throw error;
  }
  return { ...asset, id, path: toStorageRelative(target) };
}

/**
 * Adds references to a project: uploaded files become references (out of the cut), written ones are
 * stored as they are, and references of other projects are copied with their file. `montage` sets whether
 * the project opens in the montage editor (default: as it is). Returns the saved
 * montage; a reference that cannot be found or copied is reported, the rest are kept.
 */
export async function attachReferences(projectId: string, items: AttachItem[], options: { montage?: boolean } = {}): Promise<{ edit: EditDocument; skipped: string[] }> {
  const project = getProject(projectId);
  if (!project) throw new Error(translate("Project not found."));
  const assets: EditAsset[] = [];
  const references: EditReference[] = [];
  const skipped: string[] = [];
  for (const item of items) {
    if (item.source === "text") {
      references.push({ id: crypto.randomUUID(), title: item.title, roles: item.roles, content: item.content, url: item.url });
      continue;
    }
    if (item.source === "file") {
      const asset = project.edit.assets.find((a) => a.id === item.assetId);
      if (!asset) { skipped.push(translate("a uploaded file")); continue; }
      references.push({ ...fileReference(asset), roles: item.roles });
      continue;
    }
    const from = getProject(item.projectId);
    const original = from?.edit.references.find((r) => r.id === item.referenceId);
    if (!from || !original) { skipped.push(translate("a reference that no longer exists")); continue; }
    const file = original.assetId ? from.edit.assets.find((a) => a.id === original.assetId) : undefined;
    let assetId: string | undefined;
    if (file) {
      try {
        const copy = await copyAsset(projectId, file);
        assets.push(copy);
        assetId = copy.id;
      } catch { skipped.push(`«${original.title}»`); continue; }
    }
    references.push({ ...original, id: crypto.randomUUID(), roles: item.roles, assetId, analysis: undefined });
  }
  const fresh = getProject(projectId)!;
  // Uploading a file switches the project to the montage editor; a video the agent writes from a topic
  // must stay a script project, with its references beside it (`montage: false`).
  const enabled = options.montage ?? fresh.edit.enabled;
  const edit = saveEditDocument(projectId, { ...fresh.edit, enabled, assets: [...fresh.edit.assets, ...assets], references: [...fresh.edit.references, ...references] }, true);
  for (const asset of assets) warmOverview(projectId, asset);
  return { edit, skipped };
}

import { t as translate } from "@/lib/i18n";
import fs from "node:fs/promises";
import path from "node:path";
import { and, desc, eq, like, or } from "drizzle-orm";
import { getDb } from "./db";
import { globalAssets, projects, scenes, videos, type GlobalAsset, type GlobalAssetKind, type GlobalAssetSource } from "./db/schema";
import { ensureDir, resolveInStorage, storagePaths, toStorageRelative } from "./storage";
import { probeMedia } from "./media/ffprobe";
import { runFfmpeg } from "./media/ffmpeg";
import { MAX_UPLOAD_BYTES } from "./editing/upload";
import { getProject } from "./projects";
import { saveEditDocument } from "./editing/repository";
import { placeAsset } from "./editing/place";
import type { EditAsset, EditDocument } from "./editing/schema";

const videoExts = new Set([".mp4", ".mov", ".m4v", ".webm", ".mkv"]);
const audioExts = new Set([".mp3", ".wav", ".m4a", ".ogg", ".flac", ".aac"]);
const imageExts = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const documentExts = new Set([".txt", ".md", ".json", ".csv"]);

export function listGlobalAssets(filter?: {
  kind?: GlobalAssetKind | "all";
  source?: GlobalAssetSource | "all";
  search?: string;
}): GlobalAsset[] {
  const db = getDb();
  let query = db.select().from(globalAssets).$dynamic();

  const conditions = [];
  if (filter?.kind && filter.kind !== "all") {
    conditions.push(eq(globalAssets.kind, filter.kind));
  }
  if (filter?.source && filter.source !== "all") {
    conditions.push(eq(globalAssets.source, filter.source));
  }
  if (filter?.search && filter.search.trim()) {
    const term = `%${filter.search.trim().toLowerCase()}%`;
    conditions.push(
      or(
        like(globalAssets.name, term),
        like(globalAssets.context, term),
      ),
    );
  }

  if (conditions.length > 0) {
    query = query.where(and(...conditions));
  }

  return query.orderBy(desc(globalAssets.createdAt)).all();
}

export function getGlobalAsset(id: string): GlobalAsset | undefined {
  return getDb().select().from(globalAssets).where(eq(globalAssets.id, id)).get();
}

export function registerGlobalAsset(data: {
  id?: string;
  name: string;
  kind: GlobalAssetKind;
  source: GlobalAssetSource;
  path: string;
  duration?: number;
  width?: number;
  height?: number;
  hasAudio?: boolean;
  context?: string;
  projectId?: string | null;
}): GlobalAsset {
  const db = getDb();
  // Check if asset already exists by path
  const existing = db.select().from(globalAssets).where(eq(globalAssets.path, data.path)).get();
  if (existing) {
    db.update(globalAssets)
      .set({
        name: data.name,
        kind: data.kind,
        source: data.source,
        duration: data.duration ?? existing.duration,
        width: data.width ?? existing.width,
        height: data.height ?? existing.height,
        hasAudio: data.hasAudio ?? existing.hasAudio,
        context: data.context ?? existing.context,
        projectId: data.projectId !== undefined ? data.projectId : existing.projectId,
        updatedAt: new Date(),
      })
      .where(eq(globalAssets.id, existing.id))
      .run();
    return db.select().from(globalAssets).where(eq(globalAssets.id, existing.id)).get()!;
  }

  const assetId = data.id || crypto.randomUUID();
  db.insert(globalAssets)
    .values({
      id: assetId,
      name: data.name.slice(0, 240),
      kind: data.kind,
      source: data.source,
      path: data.path,
      duration: data.duration ?? 0,
      width: data.width ?? 0,
      height: data.height ?? 0,
      hasAudio: data.hasAudio ?? false,
      context: (data.context || "").slice(0, 16000),
      projectId: data.projectId ?? null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .run();

  return db.select().from(globalAssets).where(eq(globalAssets.id, assetId)).get()!;
}

export async function deleteGlobalAsset(id: string): Promise<boolean> {
  const db = getDb();
  const asset = db.select().from(globalAssets).where(eq(globalAssets.id, id)).get();
  if (!asset) return false;

  db.delete(globalAssets).where(eq(globalAssets.id, id)).run();

  // Projects that imported it point at the same file: it stays on disk while any of them uses it.
  const inUse = db
    .select({ edit: projects.edit })
    .from(projects)
    .all()
    .some((p) => (p.edit?.assets ?? []).some((a) => a.path === asset.path));
  if (inUse) return true;

  // If the file was specifically saved in global-media, remove its folder
  try {
    const absPath = resolveInStorage(asset.path);
    const globalMediaRoot = storagePaths.globalMedia();
    if (absPath.startsWith(globalMediaRoot)) {
      const parentDir = path.dirname(absPath);
      await fs.rm(parentDir, { recursive: true, force: true }).catch(() => {});
    }
  } catch {
    // Ignore cleanup errors
  }

  return true;
}

/** Library entries a project made or uploaded: tagged with it, or stored inside its folder. */
export function projectLibraryAssets(projectId: string): GlobalAsset[] {
  return getDb()
    .select()
    .from(globalAssets)
    .where(or(eq(globalAssets.projectId, projectId), like(globalAssets.path, `projects/${projectId}/%`)))
    .all();
}

/**
 * Runs before a project and its folder are deleted, so the library is never left pointing at missing files.
 * - removeFromLibrary = false: its entries stay. Files inside the project folder move to global-media first.
 * - removeFromLibrary = true: its entries leave the library, except files another project still uses: those
 *   are moved and kept, or that project's montage would break.
 * Files in shared caches (TTS voices, stock b-roll) are never deleted here; other projects may share them.
 */
export async function releaseProjectAssets(projectId: string, removeFromLibrary: boolean): Promise<{ removed: number; kept: number }> {
  const db = getDb();
  const ownPrefix = `projects/${projectId}/`;
  const others = db.select({ id: projects.id, edit: projects.edit }).from(projects).all().filter((p) => p.id !== projectId);
  const usedElsewhere = (p: string) => others.some((o) => (o.edit?.assets ?? []).some((a) => a.path === p));
  let removed = 0;
  let kept = 0;

  for (const asset of projectLibraryAssets(projectId)) {
    if (removeFromLibrary && !usedElsewhere(asset.path)) {
      await deleteGlobalAsset(asset.id);
      removed++;
      continue;
    }
    let nextPath = asset.path;
    if (asset.path.startsWith(ownPrefix)) {
      try {
        const from = resolveInStorage(asset.path);
        const to = path.join(ensureDir(path.join(storagePaths.globalMedia(), asset.id)), path.basename(from));
        await fs.rename(from, to).catch(() => fs.copyFile(from, to));
        nextPath = toStorageRelative(to);
      } catch {
        // The file is already gone: the entry would only show a broken card.
        await deleteGlobalAsset(asset.id);
        removed++;
        continue;
      }
      // Projects that imported it from the library follow it to its new place.
      for (const other of others) {
        const edit = other.edit;
        if (!edit?.assets.some((a) => a.path === asset.path)) continue;
        try {
          const assets = edit.assets.map((a) => (a.path === asset.path ? { ...a, path: nextPath } : a));
          other.edit = saveEditDocument(other.id, { ...edit, assets }, true);
        } catch {
          // Leave that project as it was rather than fail the whole delete.
        }
      }
    }
    db.update(globalAssets).set({ path: nextPath, projectId: null, updatedAt: new Date() }).where(eq(globalAssets.id, asset.id)).run();
    kept++;
  }
  return { removed, kept };
}

/** Upload a file directly to the global assets library */
export async function importFileToGlobal(file: File): Promise<GlobalAsset> {
  if (!file.size || file.size > MAX_UPLOAD_BYTES) {
    throw new Error(translate("The file must be between 1 byte and 256 MB."));
  }
  const ext = path.extname(file.name).toLowerCase();
  const kind: GlobalAssetKind | null = videoExts.has(ext)
    ? "video"
    : audioExts.has(ext)
      ? "audio"
      : imageExts.has(ext)
        ? "image"
        : documentExts.has(ext)
          ? "document"
          : null;
  if (!kind) {
    throw new Error(translate("Unadmitted format. Use video, audio, PNG / JPG / WebP or TXT / MD / JSON / CSV documents."));
  }

  const id = crypto.randomUUID();
  const dir = ensureDir(path.join(storagePaths.globalMedia(), id));
  const original = path.join(dir, `source${ext}`);
  const output = path.join(
    dir,
    kind === "video"
      ? "media.mp4"
      : kind === "audio"
        ? "media.mp3"
        : kind === "image"
          ? "media.png"
          : "document.txt",
  );

  try {
    await fs.writeFile(original, Buffer.from(await file.arrayBuffer()));
    let info = { durationSec: 0, streams: [] } as Awaited<ReturnType<typeof probeMedia>>;
    let context = "";

    if (kind === "document") {
      context = (await file.text()).slice(0, 16000);
      await fs.writeFile(output, context);
    } else {
      info = await probeMedia(original, kind === "image");
      if (kind !== "image" && (info.durationSec <= 0 || info.durationSec > 7200)) {
        throw new Error(translate("The maximum duration is two hours."));
      }
      if (kind === "video" && !info.streams.some((s) => s.type === "video")) {
        throw new Error(translate("The file does not contain video."));
      }
      if (kind === "audio" && !info.streams.some((s) => s.type === "audio")) {
        throw new Error(translate("The file does not contain audio."));
      }
      const filter =
        "scale=w='min(1920,iw)':h='min(1920,ih)':force_original_aspect_ratio=decrease,pad=ceil(iw/2)*2:ceil(ih/2)*2";
      await runFfmpeg([
        "-y",
        "-i",
        original,
        ...(kind === "video"
          ? [
              "-map",
              "0:v:0",
              "-map",
              "0:a:0?",
              "-vf",
              filter,
              "-c:v",
              "libx264",
              "-preset",
              "fast",
              "-crf",
              "20",
              "-pix_fmt",
              "yuv420p",
              "-c:a",
              "aac",
              "-movflags",
              "+faststart",
            ]
          : kind === "audio"
            ? ["-vn", "-c:a", "libmp3lame", "-q:a", "2"]
            : ["-vf", filter, "-frames:v", "1"]),
        output,
      ]);
      info = await probeMedia(output, kind === "image");
    }

    const stream = info.streams.find((s) => s.type === "video");
    const registered = registerGlobalAsset({
      id,
      name: file.name.slice(0, 240),
      kind,
      source: "upload",
      path: toStorageRelative(output),
      duration: info.durationSec,
      width: stream?.width ?? 0,
      height: stream?.height ?? 0,
      hasAudio: info.streams.some((s) => s.type === "audio"),
      context,
      projectId: null,
    });

    await fs.unlink(original).catch(() => {});
    return registered;
  } catch (err) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

/**
 * Imports an asset from the global library into a project's edit document. It shares the library's file
 * (no copy). `place`: also put it on the timeline, as an uploaded file is in the multi-file import.
 */
export function importGlobalAssetToProject(projectId: string, globalAssetId: string, options: { place?: boolean } = {}): EditDocument {
  const p = getProject(projectId);
  if (!p) throw new Error(translate("Project not found."));
  const globalAsset = getGlobalAsset(globalAssetId);
  if (!globalAsset) throw new Error("Asset global no encontrado.");

  // If already in project assets (by path or id), return existing doc
  const existing = p.edit.assets.find((a) => a.path === globalAsset.path);
  if (existing && !options.place) return p.edit;

  const asset: EditAsset = existing ?? {
    id: crypto.randomUUID(),
    name: globalAsset.name,
    kind: globalAsset.kind,
    path: globalAsset.path,
    duration: globalAsset.duration,
    width: globalAsset.width,
    height: globalAsset.height,
    hasAudio: globalAsset.hasAudio,
    context: globalAsset.context,
  };

  const nextEdit: EditDocument = {
    ...p.edit,
    enabled: true,
    assets: existing ? p.edit.assets : [...p.edit.assets, asset],
  };

  return saveEditDocument(projectId, options.place ? placeAsset(nextEdit, asset) : nextEdit, true);
}

/**
 * Scans all existing projects, rendered videos, generated TTS audio and cached media,
 * registering any that are not already in the global_assets table.
 */
export function syncExistingAssetsToGlobal(): { registered: number; total: number } {
  const db = getDb();
  let count = 0;

  // 1. Projects' assets
  const allProjects = db.select().from(projects).all();
  for (const proj of allProjects) {
    const editAssets = proj.edit?.assets ?? [];
    for (const a of editAssets) {
      let source: GlobalAssetSource = "upload";
      if (a.id.startsWith("guion-voz") || isNarrationName(a.name)) {
        source = "generated";
      } else if (a.id.startsWith("guion-plano") || a.context?.includes("B-roll de stock")) {
        source = "stock";
      }

      const existing = db.select().from(globalAssets).where(eq(globalAssets.path, a.path)).get();
      if (!existing) {
        db.insert(globalAssets)
          .values({
            id: crypto.randomUUID(),
            name: a.name,
            kind: a.kind,
            source,
            path: a.path,
            duration: a.duration,
            width: a.width,
            height: a.height,
            hasAudio: a.hasAudio,
            context: a.context || "",
            projectId: proj.id,
            createdAt: proj.createdAt,
            updatedAt: proj.updatedAt,
          })
          .run();
        count++;
      }
    }
  }

  // 2. Completed videos (rendered videos)
  const allVideos = db.select().from(videos).where(eq(videos.status, "done")).all();
  for (const v of allVideos) {
    if (!v.outputPath) continue;
    const existing = db.select().from(globalAssets).where(eq(globalAssets.path, v.outputPath)).get();
    if (!existing) {
      const proj = allProjects.find((p) => p.id === v.projectId);
      const name = `${proj?.title || proj?.topic || translate("Video generated")}${v.sceneId ? translate(" (scene)") : ""}.mp4`;
      db.insert(globalAssets)
        .values({
          id: crypto.randomUUID(),
          name,
          kind: "video",
          source: "generated",
          path: v.outputPath,
          duration: v.durationSec ?? v.expectedDurationSec ?? 0,
          width: v.width,
          height: v.height,
          hasAudio: true,
          context: translate("Project final video generated \"{0}\"", proj?.title || proj?.topic || translate("Untitled")),
          projectId: v.projectId,
          createdAt: v.finishedAt || v.createdAt,
          updatedAt: v.updatedAt,
        })
        .run();
      count++;
    }
  }

  // 3. Generated scene audio
  const allScenes = db.select().from(scenes).all();
  for (const s of allScenes) {
    if (!s.audioPath || s.ttsStatus !== "done") continue;
    const existing = db.select().from(globalAssets).where(eq(globalAssets.path, s.audioPath)).get();
    if (!existing) {
      const proj = allProjects.find((p) => p.id === s.projectId);
      const name = translate("{0} - {1} .mp3", s.position + 1, proj?.title || translate("Script"));
      db.insert(globalAssets)
        .values({
          id: crypto.randomUUID(),
          name,
          kind: "audio",
          source: "generated",
          path: s.audioPath,
          duration: s.audioDurationSec ?? 0,
          width: 0,
          height: 0,
          hasAudio: true,
          context: translate("Voice generated for the scene {0}: \"{1}\"", s.position + 1, s.narration.slice(0, 100)),
          projectId: s.projectId,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
        })
        .run();
      count++;
    }
  }

  const total = db.select().from(globalAssets).all().length;
  return { registered: count, total };
}
import { isNarrationName } from "./editing/schema";

import { t as translate } from "@/lib/i18n";
import fs from "node:fs/promises";
import path from "node:path";
import { importMedia } from "@/lib/editing/media";
import { readMediaUpload } from "@/lib/editing/upload";
import { emptyEditDocument } from "@/lib/editing/schema";
import { saveEditDocument } from "@/lib/editing/repository";
import { createProject, deleteProject } from "@/lib/projects";
import { storagePaths } from "@/lib/storage";

export async function POST(request: Request) {
  let projectId: string | null = null;
  try {
    const file = await readMediaUpload(request);
    if (!/\.(mp4|mov|m4v|webm|mkv|png|jpe?g|webp)$/i.test(file.name)) throw new Error(translate("Start with a video (MP4, MOV, M4V, WebM, MKV) or an image (PNG, JPG, WebP)."));
    const title = file.name.replace(/\.[^.]+$/, "").slice(0, 80).trim() || translate("My video");
    const project = createProject({ title, edit: { ...emptyEditDocument(), enabled: true }, music: "none" });
    projectId = project.id;
    // The first file is placed at the start; the rest follow through /api/projects/[id]/media?place=1.
    const edit = await importMedia(project.id, file, { place: true });
    const asset = edit.assets[0];
    const format = asset.width > asset.height ? "horizontal" : "vertical";
    saveEditDocument(project.id, edit, false, { title, format });
    return Response.json({ id: project.id });
  } catch (e) {
    if (projectId) {
      deleteProject(projectId);
      // Only the newly created UUID directory may be removed after an unsuccessful import.
      const parent = path.resolve(storagePaths.project(""));
      const target = path.resolve(storagePaths.project(projectId));
      if (path.dirname(target) === parent && /^[a-f\d-]{36}$/i.test(projectId)) await fs.rm(target, { recursive: true, force: true }).catch(() => {});
    }
    return Response.json({ error: e instanceof Error ? e.message : translate("You couldn't import the video.") }, { status: 400 });
  }
}

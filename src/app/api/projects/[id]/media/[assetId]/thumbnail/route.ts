import fs from "node:fs/promises";
import path from "node:path";
import { getProject } from "@/lib/projects";
import { ensureDir, resolveInStorage, storagePaths } from "@/lib/storage";
import { runFfmpeg } from "@/lib/media/ffmpeg";

const pending = new Map<string, Promise<void>>();

export async function GET(_request: Request, ctx: { params: Promise<{ id: string; assetId: string }> }) {
  const { id, assetId } = await ctx.params;
  const asset = getProject(id)?.edit.assets.find((a) => a.id === assetId && (a.kind === "video" || a.kind === "image"));
  if (!asset) return new Response(null, { status: 404 });
  const file = path.join(ensureDir(path.join(storagePaths.project(id), "thumbnails")), `${asset.id}.jpg`);
  try {
    try { await fs.access(file); } catch {
      let job = pending.get(file);
      if (!job) {
        job = runFfmpeg(["-y", "-ss", asset.kind === "video" ? String(Math.min(0.5, asset.duration / 2)) : "0", "-i", resolveInStorage(asset.path), "-frames:v", "1", "-vf", "scale=480:320:force_original_aspect_ratio=decrease", "-q:v", "5", file]).then(() => {}).finally(() => pending.delete(file));
        pending.set(file, job);
      }
      await job;
    }
    return new Response(await fs.readFile(file), { headers: { "content-type": "image/jpeg", "cache-control": "private, max-age=86400" } });
  } catch { return new Response(null, { status: 404 }); }
}

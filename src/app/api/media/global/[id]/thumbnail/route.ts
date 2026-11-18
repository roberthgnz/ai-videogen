import fs from "node:fs/promises";
import path from "node:path";
import { getGlobalAsset } from "@/lib/global-assets";
import { ensureDir, resolveInStorage, storagePaths } from "@/lib/storage";
import { runFfmpeg } from "@/lib/media/ffmpeg";

const pending = new Map<string, Promise<void>>();

export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const asset = getGlobalAsset(id);
  if (!asset || (asset.kind !== "video" && asset.kind !== "image")) {
    return new Response(null, { status: 404 });
  }

  // If image, serve directly
  if (asset.kind === "image") {
    try {
      const file = resolveInStorage(asset.path);
      const ext = path.extname(file).toLowerCase();
      const contentType = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
      return new Response(await fs.readFile(file), {
        headers: { "content-type": contentType, "cache-control": "private, max-age=86400" },
      });
    } catch {
      return new Response(null, { status: 404 });
    }
  }

  // For video, generate or serve thumbnail
  const thumbDir = ensureDir(path.join(storagePaths.mediaCache(), "thumbnails"));
  const thumbFile = path.join(thumbDir, `${asset.id}.jpg`);

  try {
    try {
      await fs.access(thumbFile);
    } catch {
      let job = pending.get(thumbFile);
      if (!job) {
        job = runFfmpeg([
          "-y",
          "-ss",
          String(Math.min(0.5, asset.duration / 2)),
          "-i",
          resolveInStorage(asset.path),
          "-frames:v",
          "1",
          "-vf",
          "scale=480:320:force_original_aspect_ratio=decrease",
          "-q:v",
          "5",
          thumbFile,
        ])
          .then(() => {})
          .finally(() => pending.delete(thumbFile));
        pending.set(thumbFile, job);
      }
      await job;
    }
    return new Response(await fs.readFile(thumbFile), {
      headers: { "content-type": "image/jpeg", "cache-control": "private, max-age=86400" },
    });
  } catch {
    return new Response(null, { status: 404 });
  }
}

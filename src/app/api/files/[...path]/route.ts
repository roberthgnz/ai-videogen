import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import type { NextRequest } from "next/server";
import { connection } from "next/server";
import { resolveInStorage } from "@/lib/storage";

/**
 * Serves generated media from the storage folder (audio previews, MP4s).
 * Supports HTTP Range so <audio>/<video> can seek. Only known media types,
 * and only paths inside storage (resolveInStorage rejects traversal).
 */
const CONTENT_TYPES: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json",
};

export async function GET(request: NextRequest, ctx: RouteContext<"/api/files/[...path]">) {
  await connection();
  const { path: segments } = await ctx.params;

  let file: string;
  try {
    file = resolveInStorage(segments.map(decodeURIComponent).join("/"));
  } catch {
    return new Response("Not found", { status: 404 });
  }
  const type = CONTENT_TYPES[path.extname(file).toLowerCase()];
  if (!type) return new Response("Not found", { status: 404 });

  let size: number;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return new Response("Not found", { status: 404 });
    size = stat.size;
  } catch {
    return new Response("Not found", { status: 404 });
  }

  const headers = new Headers({
    "content-type": type,
    "accept-ranges": "bytes",
    "cache-control": "no-cache",
  });
  if (request.nextUrl.searchParams.has("download")) {
    headers.set("content-disposition", `attachment; filename="${path.basename(file)}"`);
  }

  const range = parseRange(request.headers.get("range"), size);
  if (range === "invalid") {
    headers.set("content-range", `bytes */${size}`);
    return new Response(null, { status: 416, headers });
  }

  const { start, end } = range ?? { start: 0, end: size - 1 };
  headers.set("content-length", String(size === 0 ? 0 : end - start + 1));
  if (range) headers.set("content-range", `bytes ${start}-${end}/${size}`);

  const body = size === 0 ? null : (Readable.toWeb(fs.createReadStream(file, { start, end })) as ReadableStream);
  return new Response(body, { status: range ? 206 : 200, headers });
}

function parseRange(header: string | null, size: number): { start: number; end: number } | null | "invalid" {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return "invalid";
  let start: number;
  let end: number;
  if (!match[1]) {
    // Suffix range: last N bytes.
    const suffix = Number(match[2]);
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  }
  if (start > end || start >= size) return "invalid";
  return { start, end };
}

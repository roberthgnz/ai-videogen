import fs from "node:fs";
import path from "node:path";
import { env } from "./env";

/**
 * Everything the app writes (SQLite DB, TTS cache, HyperFrames builds, MP4s)
 * lives under one storage root. Paths stored in the DB are relative to it,
 * with forward slashes, so the folder can be moved.
 */
export function storageRoot(): string {
  if (process.env.VIDEOGEN_DESKTOP === "1") {
    const root = env().STORAGE_DIR;
    if (!path.isAbsolute(root)) throw new Error("STORAGE_DIR debe ser una ruta absoluta en escritorio.");
    return root;
  }
  // Runtime data dir, not app code: keep it out of Next's output tracing.
  return path.resolve(/*turbopackIgnore: true*/ process.cwd(), env().STORAGE_DIR);
}

export const storagePaths = {
  db: () => path.join(storageRoot(), "app.db"),
  ttsCache: () => path.join(storageRoot(), "cache", "tts"),
  /** Normalized b-roll clips and stills, shared by every project. */
  mediaCache: () => path.join(storageRoot(), "cache", "media"),
  /** Provider search responses (kept 24 h, as stock APIs require). */
  searchCache: () => path.join(storageRoot(), "cache", "media", "search"),
  /** Background music the user drops in (any of mp3, wav, m4a, ogg, flac). */
  music: () => path.join(storageRoot(), "music"),
  /** Optional transition effects (whooshes), same formats. */
  sfx: () => path.join(storageRoot(), "sfx"),
  /** Music tracks cut to a video's length and levelled. */
  musicCache: () => path.join(storageRoot(), "cache", "music"),
  project: (projectId: string) => path.join(storageRoot(), "projects", projectId),
  video: (projectId: string, videoId: string) =>
    path.join(storageRoot(), "projects", projectId, "videos", videoId),
  /** Global assets library folder (uploaded or saved globally). */
  globalMedia: () => path.join(storageRoot(), "global-media"),
};

export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Absolute path -> storage-relative path (posix separators). */
export function toStorageRelative(absPath: string): string {
  const rel = path.relative(storageRoot(), path.resolve(absPath));
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path is outside storage: ${absPath}`);
  }
  return rel.split(path.sep).join("/");
}

/** Storage-relative path -> absolute path. Rejects anything that escapes the root. */
export function resolveInStorage(relPath: string): string {
  const root = storageRoot();
  const abs = path.resolve(/*turbopackIgnore: true*/ root, relPath);
  const rel = path.relative(root, abs);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path is outside storage: ${relPath}`);
  }
  return abs;
}

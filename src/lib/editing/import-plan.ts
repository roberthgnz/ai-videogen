import { t as translate } from "@/lib/i18n";
export const VISUAL_FILE = /\.(mp4|mov|m4v|webm|mkv|png|jpe?g|webp)$/i;
export const AUDIO_FILE = /\.(mp3|wav|m4a|ogg|flac|aac)$/i;
export const MAX_IMPORT_FILES = 20;

export type ImportPlan<T> = { ok: true; ordered: T[]; skipped: number } | { ok: false; error: string };

/** A file to import: its name says what it is, unless `kind` does (files from the library may have no extension). */
type Importable = { name: string; kind?: "video" | "image" | "audio" | "document" };
const isVisual = (f: Importable) => (f.kind ? f.kind === "video" || f.kind === "image" : VISUAL_FILE.test(f.name));
const isAudio = (f: Importable) => (f.kind ? f.kind === "audio" : AUDIO_FILE.test(f.name));

/**
 * Which of the picked files to import and in what order: videos and images
 * in the order chosen, then audio (music is cut to the picture, so it goes
 * last). Anything else is skipped and counted.
 */
export function planImport<T extends Importable>(picked: T[]): ImportPlan<T> {
  const files = picked.filter((f) => isVisual(f) || isAudio(f));
  if (files.length === 0) {
    return { ok: false, error: translate("Admitted formats: video (MP4, MOV, M4V, WebM, MKV), image (PNG, JPG, WebP) and audio (MP3, WAV, M4 A, OGG, FLAC, AAC).") };
  }
  if (files.length > MAX_IMPORT_FILES) return { ok: false, error: translate("You can import up to {0} files at once.", MAX_IMPORT_FILES) };
  const ordered = [...files.filter(isVisual), ...files.filter(isAudio)];
  if (!isVisual(ordered[0])) return { ok: false, error: translate("Add at least one video or image: audio is only used as music.") };
  return { ok: true, ordered, skipped: picked.length - files.length };
}

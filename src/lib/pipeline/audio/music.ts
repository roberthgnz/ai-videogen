import { t as translate } from "@/lib/i18n";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { runFfmpeg } from "@/lib/media/ffmpeg";
import { storagePaths } from "@/lib/storage";
import { PipelineError } from "../errors";

export const AUDIO_EXTENSIONS = [".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac"];

/** Project setting values that are not file names. */
export const MUSIC_AUTO = "auto";
export const MUSIC_NONE = "none";

function listAudio(dir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && AUDIO_EXTENSIONS.includes(path.extname(e.name).toLowerCase()))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
}

/** Track file names in storage/music, sorted. */
export function listMusic(): string[] {
  return listAudio(storagePaths.music());
}

/** Effect file names in storage/sfx, sorted. */
export function listSfx(): string[] {
  return listAudio(storagePaths.sfx());
}

/**
 * The track a project uses: "none" -> no music, a file name -> that file (if
 * it still exists), "auto" -> one of the library, always the same for a given
 * `seed` so re-rendering a project keeps its music.
 */
export function resolveMusic(setting: string, seed: string, library = listMusic()): string | null {
  if (setting === MUSIC_NONE || library.length === 0) return null;
  if (setting !== MUSIC_AUTO) return library.includes(setting) ? setting : null;
  const hash = createHash("sha1").update(seed).digest();
  return library[hash.readUInt32BE(0) % library.length];
}

/** Bed loudness before the mix: every track then sits at the same level under the voice. */
const BED_LUFS = -18;

/**
 * The track cut (or looped) to the video's length and levelled, cached by
 * source file and duration. Returns the prepared file.
 */
export async function prepareMusic(fileName: string, durationSec: number, signal?: AbortSignal): Promise<string> {
  const source = path.join(storagePaths.music(), path.basename(fileName));
  let stat: fs.Stats;
  try {
    stat = fs.statSync(source);
  } catch {
    throw new PipelineError("composition", translate("The music \"{0}\" is not found in storage/music.", fileName));
  }
  const seconds = Math.ceil(durationSec * 10) / 10;
  const key = createHash("sha1").update(`${fileName}|${stat.size}|${stat.mtimeMs}|${seconds}|${BED_LUFS}`).digest("hex").slice(0, 16);
  const outFile = path.join(storagePaths.musicCache(), `${key}.mp3`);
  if (fs.existsSync(outFile)) return outFile;

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const partial = `${outFile}.part.mp3`;
  try {
    await runFfmpeg(
      [
        "-v", "error", "-y",
        // Loop the track if the video is longer than it.
        "-stream_loop", "-1", "-i", source,
        "-t", String(seconds),
        "-vn",
        "-af", `loudnorm=I=${BED_LUFS}:TP=-2:LRA=11,aresample=44100`,
        "-ac", "2", "-c:a", "libmp3lame", "-b:a", "192k",
        partial,
      ],
      signal,
    );
    fs.renameSync(partial, outFile);
    return outFile;
  } catch (error) {
    fs.rmSync(partial, { force: true });
    throw new PipelineError("composition", translate("The music \"{0}\" could not be prepared: {1}", fileName, error instanceof Error ? error.message : error), {
      cause: error,
    });
  }
}

import { t as translate } from "@/lib/i18n";
import fs from "node:fs/promises";
import type { WordTiming } from "@/lib/domain";
import { getProject } from "@/lib/projects";
import { resolveInStorage } from "@/lib/storage";
import { analyzeMedia, transcriptCachePath } from "./media";
import { cachedEnergy, quietStretches } from "./silence";
import type { AudioEnergy } from "./transcript";
import { transcriptWordsSchema } from "./transcript-schema";

/**
 * Word timings of a file of the project, from the analysis cache. With `transcribe`, a file never
 * transcribed (or transcribed before word timings were kept) is transcribed first: slow, the local
 * model may download the first time. Null when there are no words to give.
 */
export async function transcriptWords(projectId: string, assetId: string, transcribe = false): Promise<WordTiming[] | null> {
  const asset = getProject(projectId)?.edit.assets.find((a) => a.id === assetId);
  if (!asset) throw new Error(translate("File not found in the project."));
  if (!asset.hasAudio) throw new Error(translate("\"{0}\" has no sound: there is nothing to transcribe.", asset.name));
  // The transcription (and its cache, with the words checked against the audio) is analyzeMedia's.
  if (!transcribe && !(await transcribed(projectId, assetId))) return null;
  const result = await analyzeMedia(projectId, assetId, "transcribe");
  return "words" in result && result.words?.length ? result.words : null;
}

/** Quiet stretches of a file (seconds of the file), measured against its own level. */
export async function transcriptPauses(projectId: string, assetId: string, minSeconds = 0.3) {
  const asset = getProject(projectId)?.edit.assets.find((a) => a.id === assetId);
  if (!asset?.hasAudio) return [];
  return quietStretches(resolveInStorage(asset.path), minSeconds);
}

/** The level envelope of a file (see audioEnergy), measured once and cached with its other analyses. */
export async function transcriptEnergy(projectId: string, assetId: string): Promise<AudioEnergy | null> {
  const asset = getProject(projectId)?.edit.assets.find((a) => a.id === assetId);
  return asset?.hasAudio ? cachedEnergy(projectId, asset) : null;
}

/** Whether a file already has word timings cached (asking for them then costs nothing). */
async function transcribed(projectId: string, assetId: string): Promise<boolean> {
  try {
    const cached = JSON.parse(await fs.readFile(transcriptCachePath(projectId, assetId), "utf8")) as { words?: unknown };
    const words = transcriptWordsSchema.safeParse(cached.words);
    return words.success && words.data.length > 0;
  } catch { return false; }
}

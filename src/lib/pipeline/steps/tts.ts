import { t as translate } from "@/lib/i18n";
import fs from "node:fs";
import type { Scene } from "@/lib/db/schema";
import type { AudioStatus } from "@/lib/domain";
import { probeDuration } from "@/lib/media/ffprobe";
import { getProject, getScene, setSceneAudio, setSceneTtsStatus } from "@/lib/projects";
import { resolveInStorage, toStorageRelative } from "@/lib/storage";
import { alignWords } from "../alignment";
import { errorMessage, PipelineError } from "../errors";
import { getCachedTts, type CachedTts } from "../tts";

export type { AudioStatus } from "@/lib/domain";

// Jobs live in this process (and survive dev hot reloads). A scene marked
// "running" in the DB that is in neither set was interrupted (server restart).
const globalForTts = globalThis as unknown as {
  __videogenTtsRunning?: Set<string>;
  __videogenTtsQueued?: Set<string>;
};
const running = (globalForTts.__videogenTtsRunning ??= new Set());
const queued = (globalForTts.__videogenTtsQueued ??= new Set());

export function isTtsActive(sceneId: string): boolean {
  return running.has(sceneId) || queued.has(sceneId);
}

export const INTERRUPTED_MESSAGE = "The generation was interrupted (did the server reboot?).";

/**
 * Where a scene's audio stands, given the cache key its current narration
 * and voice would produce. "stale" = audio exists but text/voice/settings changed.
 */
export function sceneAudioStatus(scene: Scene, expectedHash: string | null): AudioStatus {
  if (scene.ttsStatus === "running") return isTtsActive(scene.id) ? "running" : "error";
  if (scene.ttsStatus === "error") return "error";
  if (!scene.audioHash || !scene.audioPath) return "none";
  if (!expectedHash || scene.audioHash !== expectedHash) return "stale";
  try {
    if (!fs.existsSync(resolveInStorage(scene.audioPath))) return "none";
  } catch {
    return "none";
  }
  return "ready";
}

/** Error to show for a scene, including interrupted jobs. */
export function sceneAudioError(scene: Scene): string | null {
  if (scene.ttsStatus === "running" && !isTtsActive(scene.id)) return INTERRUPTED_MESSAGE;
  return scene.ttsStatus === "error" ? scene.ttsError : null;
}

/** Expected cache key per scene for the project's current voice (null when no voice is set). */
export function expectedAudioHashes(
  sceneList: Pick<Scene, "id" | "narration">[],
  voiceId: string | null,
  tts: CachedTts = getCachedTts(),
): Record<string, string | null> {
  return Object.fromEntries(
    sceneList.map((s) => [s.id, voiceId && s.narration.trim() ? tts.key({ text: s.narration.trim(), voiceId }) : null]),
  );
}

export interface SceneTtsOutcome {
  sceneId: string;
  ok: boolean;
  /** "generated" = paid TTS call, "cached" = served from disk, "skipped" = already up to date. */
  source?: "generated" | "cached" | "skipped";
  error?: string;
}

/**
 * TTS + alignment for one scene: audio from the cache or the provider,
 * word timings from the provider's alignment, real duration from ffprobe.
 * `force` asks the provider for a new take even if the audio is cached.
 */
export async function runTtsForScene(
  sceneId: string,
  options: { force?: boolean; tts?: CachedTts; voiceId?: string } = {},
): Promise<SceneTtsOutcome> {
  queued.delete(sceneId);
  const scene = getScene(sceneId);
  if (!scene) return { sceneId, ok: false, error: translate("Scene not found.") };
  if (running.has(sceneId)) return { sceneId, ok: true, source: "skipped" };

  const tts = options.tts ?? getCachedTts();
  const voiceId = options.voiceId ?? getProject(scene.projectId)?.voiceId ?? null;
  const text = scene.narration.trim();

  running.add(sceneId);
  try {
    if (!voiceId) throw new PipelineError("tts", translate("Choose a voice for the project before generating the audio."));
    if (!text) throw new PipelineError("tts", translate("The story of this scene is empty."));

    const request = { text, voiceId };
    if (!options.force && sceneAudioStatus({ ...scene, ttsStatus: "idle" }, tts.key(request)) === "ready") {
      if (scene.ttsStatus !== "done") setSceneTtsStatus(sceneId, "done");
      return { sceneId, ok: true, source: "skipped" };
    }

    setSceneTtsStatus(sceneId, "running");
    const audio = await tts.get(request, { force: options.force });
    const words = alignWords(text, audio.alignment);
    const audioDurationSec = await probeDuration(audio.audioPath);

    setSceneAudio(sceneId, {
      audioHash: audio.hash,
      audioPath: toStorageRelative(audio.audioPath),
      audioDurationSec,
      words,
    });
    return { sceneId, ok: true, source: audio.fromCache ? "cached" : "generated" };
  } catch (error) {
    const message = errorMessage(error);
    console.error(`[tts] scene ${sceneId}:`, error);
    setSceneTtsStatus(sceneId, "error", message);
    return { sceneId, ok: false, error: message };
  } finally {
    running.delete(sceneId);
  }
}

export interface ProjectTtsOutcome {
  ok: boolean;
  scenes: SceneTtsOutcome[];
  /** Summary for the UI. */
  error?: string;
}

type Checked = { ok: false; error: string } | { ok: true; project: NonNullable<ReturnType<typeof getProject>> };

function checkProject(projectId: string): Checked {
  const project = getProject(projectId);
  if (!project) return { ok: false, error: translate("Project not found.") };
  if (!project.voiceId) return { ok: false, error: translate("Choose a voice and save before generating the audio.") };
  if (project.scenes.length === 0) return { ok: false, error: translate("The project has no scenes.") };
  return { ok: true, project };
}

/**
 * TTS for the scenes of a project (all, or `sceneIds`). Up-to-date scenes
 * are skipped and cached audio costs nothing. Awaits completion.
 */
export async function runTtsForProject(
  projectId: string,
  options: { tts?: CachedTts; concurrency?: number; sceneIds?: string[] } = {},
): Promise<ProjectTtsOutcome> {
  const checked = checkProject(projectId);
  if (!checked.ok) return { ok: false, scenes: [], error: checked.error };
  const { project } = checked;

  const tts = options.tts ?? getCachedTts();
  const wanted = options.sceneIds ? new Set(options.sceneIds) : null;
  const queue = project.scenes.filter((s) => !wanted || wanted.has(s.id));
  const results: SceneTtsOutcome[] = [];
  const worker = async () => {
    for (let scene = queue.shift(); scene; scene = queue.shift()) {
      results.push(await runTtsForScene(scene.id, { tts, voiceId: project.voiceId! }));
    }
  };
  // Providers limit concurrent requests per plan; 2 is safe everywhere.
  await Promise.all(Array.from({ length: Math.max(1, options.concurrency ?? 2) }, worker));

  const order = new Map(project.scenes.map((s, i) => [s.id, i]));
  results.sort((a, b) => order.get(a.sceneId)! - order.get(b.sceneId)!);
  const failed = results.filter((r) => !r.ok);
  return {
    ok: failed.length === 0,
    scenes: results,
    error: failed.length
      ? translate("The audio of {0} scene (s) failed:\n{1}", failed.length, failed.map((f) => translate("- Scene {0}: {1}", order.get(f.sceneId)! + 1, f.error)).join("\n"))
      : undefined,
  };
}

export type StartResult = { ok: true; queued: number } | { ok: false; error: string };

function markQueued(sceneIds: string[]) {
  for (const id of sceneIds) {
    queued.add(id);
    setSceneTtsStatus(id, "running");
  }
}

/**
 * Queues TTS for every scene without up-to-date audio and returns at once;
 * progress is visible through each scene's status (the UI polls it).
 */
export function startTtsForProject(projectId: string, options: { tts?: CachedTts } = {}): StartResult {
  const checked = checkProject(projectId);
  if (!checked.ok) return { ok: false, error: checked.error };
  const { project } = checked;

  const tts = options.tts ?? getCachedTts();
  const hashes = expectedAudioHashes(project.scenes, project.voiceId, tts);
  const targets = project.scenes
    .filter((s) => !isTtsActive(s.id) && sceneAudioStatus(s, hashes[s.id]) !== "ready")
    .map((s) => s.id);
  if (targets.length === 0) return { ok: true, queued: 0 };

  markQueued(targets);
  void runTtsForProject(projectId, { tts, sceneIds: targets }).catch((error) =>
    console.error(`[tts] project ${projectId}:`, error),
  );
  return { ok: true, queued: targets.length };
}

/** Queues TTS for one scene (`force` = new take) and returns at once. */
export function startTtsForScene(sceneId: string, options: { force?: boolean; tts?: CachedTts } = {}): StartResult {
  if (isTtsActive(sceneId)) return { ok: true, queued: 0 };
  markQueued([sceneId]);
  void runTtsForScene(sceneId, options).catch((error) => console.error(`[tts] scene ${sceneId}:`, error));
  return { ok: true, queued: 1 };
}

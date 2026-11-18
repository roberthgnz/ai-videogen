import { t as translate } from "@/lib/i18n";
import fs from "node:fs";
import path from "node:path";
import type { Video } from "@/lib/db/schema";
import { FORMAT_SIZE, type VideoFormat } from "@/lib/domain";
import { type EditDocument } from "@/lib/editing/schema";
import { probeMedia, type MediaInfo } from "@/lib/media/ffprobe";
import { theme } from "@/theme";
import { normalizeLoudness } from "../audio/loudness";
import { listSfx, prepareMusic, resolveMusic } from "../audio/music";
import { compositionDuration } from "../composition";
import { createVideo, getProject, updateVideo } from "@/lib/projects";
import { storagePaths, toStorageRelative } from "@/lib/storage";
import { errorMessage, PipelineError } from "../errors";
import { registerGlobalAsset } from "../../global-assets";
import { getRenderer, type RenderQuality, type Renderer } from "../render";
import type { CachedTts } from "../tts";
import type { VisualProvider } from "../visuals";
import { composeProject } from "./compose";
import { isTtsActive, runTtsForProject } from "./tts";
import { runVisualsForProject, type VisualsOptions } from "./visuals";

// Video jobs running in this process (survive dev hot reloads). A video left
// in progress that isn't here was interrupted.
const globalForVideo = globalThis as unknown as { __videogenRenders?: Map<string, AbortController> };
const active = (globalForVideo.__videogenRenders ??= new Map());

export function isRenderActive(videoId: string): boolean {
  return active.has(videoId);
}

export const RENDER_INTERRUPTED = "The render was interrupted. Generate the video again.";

/** Status to show, turning orphaned in-progress videos into errors. */
export function videoView(video: Video): Video {
  const inProgress = video.status === "queued" || video.status === "composing" || video.status === "rendering";
  if (inProgress && !isRenderActive(video.id)) return { ...video, status: "error", error: translate(RENDER_INTERRUPTED) };
  return video;
}

/** Pipeline step a video's stage belongs to (where it is, or where it failed). */
export type VideoStep = "tts" | "visuals" | "compose" | "render";
export function videoStep(video: Pick<Video, "stage" | "status">): VideoStep {
  if (video.stage === "tts") return "tts";
  if (video.stage === "visuals") return "visuals";
  if (video.stage === "compose" || video.status === "composing") return "compose";
  return "render";
}

/** Allowed difference between the MP4 and the composition (one frame at 30 fps + container rounding). */
const DURATION_TOLERANCE = 0.1;

/** Checks the rendered file has video, audio and the expected size and duration. */
export function verifyOutput(info: MediaInfo, expected: { width: number; height: number; durationSec: number; requireAudio?: boolean }): string[] {
  const problems: string[] = [];
  const video = info.streams.find((s) => s.type === "video");
  const audio = info.streams.find((s) => s.type === "audio");
  if (!video) problems.push(translate("MP4 has no video track"));
  else if (video.width !== expected.width || video.height !== expected.height) {
    problems.push(translate("resolution {0} x {1}, was expected {2} x {3}", video.width, video.height, expected.width, expected.height));
  }
  if (!audio && expected.requireAudio !== false) problems.push(translate("MP4 has no audio track"));
  if (Math.abs(info.durationSec - expected.durationSec) > DURATION_TOLERANCE) {
    problems.push(translate("Duration was {0}s. Expected {1}s.", info.durationSec.toFixed(3), expected.durationSec.toFixed(3)));
  }
  return problems;
}

export interface StartVideoOptions {
  source?: "script" | "montage";
  format?: VideoFormat;
  quality?: RenderQuality;
  /** Render only this scene (a preview); its audio must exist. */
  sceneId?: string;
  /** Generate missing or stale audio first (default true for full videos). */
  generateAudio?: boolean;
  renderer?: Renderer;
  tts?: CachedTts;
  /** B-roll provider (null = none). Default: the configured one. */
  visualProvider?: VisualProvider | null;
  /** Injected in tests instead of the real download. */
  ensureVisualFile?: VisualsOptions["ensureFile"];
  /** Absolute path of an .mp4 to copy the finished video to, besides the project's own copy. */
  saveTo?: string;
  /** Replace a file already at `saveTo` (the user confirmed it); otherwise the copy takes a free name next to it. */
  overwrite?: boolean;
}

export type StartVideoResult = { ok: true; videoId: string } | { ok: false; error: string };

/**
 * Orchestrator: voice (only what is missing; cached audio is free) ->
 * b-roll (search, pick, download; cached too) -> composition -> render ->
 * ffprobe verification, in the background. Every
 * step writes its stage on the video row, so the UI shows progress and, on
 * failure, which step failed and the real error. Retrying starts a new
 * version and only redoes what is not done yet.
 */
export function startVideo(projectId: string, options: StartVideoOptions = {}): StartVideoResult {
  const project = getProject(projectId);
  if (!project) return { ok: false, error: translate("Project not found.") };
  const editing = options.source !== "script" && !options.sceneId && (options.source === "montage" ||
    (project.edit.enabled && (!!project.edit.clips.length || !!project.edit.overlays.length || !project.scenes.length)));
  if (!editing && project.scenes.length === 0) return { ok: false, error: translate("The project has no scenes.") };
  if (!editing && !project.voiceId) return { ok: false, error: translate("Choose a voice and save before you generate the video.") };
  if (editing && !project.edit.clips.length && !project.edit.overlays.length) return { ok: false, error: translate("Add a clip or text before exporting.") };
  if (options.sceneId && !project.scenes.some((s) => s.id === options.sceneId)) {
    return { ok: false, error: translate("Scene not found.") };
  }
  if (active.size > 0) return { ok: false, error: translate("Wait for the current render to finish.") };
  if (project.scenes.some((s) => isTtsActive(s.id))) {
    return { ok: false, error: translate("Wait for audio generation to finish.") };
  }

  const format = options.format ?? project.format;
  const { width, height } = FORMAT_SIZE[format];
  const generateAudio = !editing && (options.generateAudio ?? !options.sceneId);
  const video = createVideo({
    projectId,
    sceneId: options.sceneId ?? null,
    format,
    width,
    height,
    status: "queued",
    stage: generateAudio ? "tts" : "compose",
    startedAt: new Date(),
  });

  const controller = new AbortController();
  active.set(video.id, controller);
  void runVideoJob(video.id, projectId, {
    format,
    width,
    height,
    generateAudio,
    sceneId: options.sceneId,
    quality: options.quality ?? (options.sceneId ? "draft" : "looks"),
    renderer: options.renderer ?? getRenderer(),
    tts: options.tts,
    visualProvider: options.visualProvider,
    ensureVisualFile: options.ensureVisualFile,
    signal: controller.signal,
    edit: editing ? structuredClone(project.edit) : undefined,
    saveTo: options.saveTo,
    overwrite: options.overwrite,
  }).finally(() => active.delete(video.id));

  return { ok: true, videoId: video.id };
}

export function cancelVideo(videoId: string): boolean {
  const controller = active.get(videoId);
  controller?.abort();
  return !!controller;
}

/** `file`, or «name (2).mp4», «name (3).mp4»… next to it when that one is taken. */
function freeName(file: string): string {
  if (!fs.existsSync(file)) return file;
  const ext = path.extname(file);
  const base = file.slice(0, file.length - ext.length);
  for (let n = 2; ; n++) {
    const candidate = `${base} (${n})${ext}`;
    if (!fs.existsSync(candidate)) return candidate;
  }
}

/** Copies the finished MP4 to where the user chose. Resolves to the path written, or to what went wrong. */
async function saveCopy(source: string, target: string, overwrite: boolean): Promise<{ path: string } | { error: string }> {
  try {
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    const destination = overwrite ? target : freeName(target);
    await fs.promises.copyFile(source, destination);
    return { path: destination };
  } catch (error) {
    console.error(`[video] copy to ${target}:`, error);
    const code = (error as NodeJS.ErrnoException).code;
    const why = code === "EBUSY" || code === "EPERM" ? translate("the file is open in another program or that folder does not support changes")
      : code === "EACCES" ? translate("no permission to write in that folder")
      : code === "ENOSPC" ? translate("no space left on the disk")
      : errorMessage(error);
    return { error: translate("The video is ready, but it could not be saved in \"{0}\": {1}. Download it from Exports.", target, why) };
  }
}

async function runVideoJob(
  videoId: string,
  projectId: string,
  job: {
    format: VideoFormat;
    width: number;
    height: number;
    generateAudio: boolean;
    sceneId?: string;
    quality: RenderQuality;
    renderer: Renderer;
    tts?: CachedTts;
    visualProvider?: VisualProvider | null;
    ensureVisualFile?: VisualsOptions["ensureFile"];
    signal: AbortSignal;
    edit?: EditDocument;
    saveTo?: string;
    overwrite?: boolean;
  },
): Promise<void> {
  const dir = storagePaths.video(projectId, videoId);
  const buildDir = path.join(dir, "build");
  const outFile = path.join(dir, "video.mp4");

  try {
    // 1. Voice: only scenes without fresh audio are synthesized.
    if (job.generateAudio) {
      const tts = await runTtsForProject(projectId, { tts: job.tts });
      if (!tts.ok) throw new PipelineError("tts", tts.error ?? translate("Voice generation failed."));
    }
    if (job.signal.aborted) throw new PipelineError("render", translate("Render canceled."));

    // 2. B-roll: one asset per shot, downloaded and cropped to this format.
    if (!job.edit) {
    updateVideo(videoId, { stage: "visuals" });
    const visuals = await runVisualsForProject(projectId, {
      format: job.format,
      sceneIds: job.sceneId ? [job.sceneId] : undefined,
      download: true,
      provider: job.visualProvider,
      ensureFile: job.ensureVisualFile,
      signal: job.signal,
    });
    if (!visuals.ok) throw new PipelineError("visuals", visuals.error);
    }
    if (job.signal.aborted) throw new PipelineError("render", translate("Render canceled."));

    // 3. Composition, with the music cut to length (full videos only; previews stay dry).
    updateVideo(videoId, { status: "composing", stage: "compose" });
    const fresh = getProject(projectId);
    if (!fresh) throw new PipelineError("composition", translate("Project not found."));
    let music: string | undefined;
    let sfx: string[] = [];
    if (!job.sceneId && !job.edit) {
      const track = resolveMusic(fresh.music, projectId);
      if (track) {
        const total = compositionDuration(fresh.scenes.map((s) => s.audioDurationSec ?? 0));
        music = await prepareMusic(track, total, job.signal);
      }
      if (fresh.sfx) sfx = listSfx().map((name) => path.join(storagePaths.sfx(), name));
    }
    const plan = composeProject(projectId, buildDir, {
      source: job.edit ? "montage" : "script",
      format: job.format,
      tts: job.tts,
      sceneIds: job.sceneId ? [job.sceneId] : undefined,
      music,
      sfx,
      editSnapshot: job.edit,
    });
    updateVideo(videoId, {
      status: "rendering",
      stage: "compile",
      progress: 0,
      buildDir: toStorageRelative(buildDir),
      expectedDurationSec: plan.durationSec,
    });

    // 4. Render, with throttled progress writes.
    let lastWrite = 0;
    let lastPercent = -1;
    const result = await job.renderer.render({
      projectDir: buildDir,
      outFile,
      quality: job.quality,
      signal: job.signal,
      onProgress: (p) => {
        const now = Date.now();
        const percent = Math.floor(p.percent);
        if (percent === lastPercent && now - lastWrite < 1000) return;
        if (now - lastWrite < 300 && percent - lastPercent < 5) return;
        lastWrite = now;
        lastPercent = percent;
        updateVideo(videoId, { stage: p.stage, progress: p.percent });
      },
    });

    // 5. Loudness: the final mix is brought to the target level, then measured.
    // (A render without an audio track is left alone: verification reports it.)
    updateVideo(videoId, { stage: "normalize", progress: 100 });
    const rendered = await probeMedia(outFile);
    // Manual montages are levelled too (social platforms play at about -14 LUFS), but a mix that is practically
    // silent was muted on purpose and stays so, and the boost is capped so a very quiet mix is not blown up.
    const loudness = rendered.streams.some((s) => s.type === "audio")
      ? await normalizeLoudness(outFile, theme.audio.target, job.signal, job.edit ? { silentBelow: -45, maxGainDb: 10 } : {})
      : null;

    // 6. Verification.
    const info = await probeMedia(outFile);
    const requireAudio = !job.edit || job.edit.clips.some((c) => c.volume > 0 && job.edit!.assets.find((a) => a.id === c.assetId)?.hasAudio);
    const problems = verifyOutput(info, { width: job.width, height: job.height, durationSec: plan.durationSec, requireAudio });
    if (problems.length) {
      throw new PipelineError("render", translate("The MP4 failed validation. {0}", problems.join("; ")));
    }

    // 7. The copy where the user chose to keep it. Failing here does not fail the video: it stays in the project.
    let saved: { path: string } | { error: string } | null = null;
    if (job.saveTo) {
      updateVideo(videoId, { stage: "save" });
      saved = await saveCopy(outFile, job.saveTo, !!job.overwrite);
    }
    updateVideo(videoId, {
      status: "done",
      stage: "done",
      progress: 100,
      outputPath: toStorageRelative(outFile),
      savedPath: saved && "path" in saved ? saved.path : null,
      durationSec: info.durationSec,
      loudnessLufs: loudness?.lufs ?? null,
      log: result.log.slice(-8000),
      error: saved && "error" in saved ? saved.error : null,
      finishedAt: new Date(),
    });
    try {
      const owner = getProject(projectId);
      const title = owner?.title || owner?.topic || translate("Untitled");
      registerGlobalAsset({
        name: translate("Final video - {0}.mp4", title),
        kind: "video",
        source: "generated",
        path: toStorageRelative(outFile),
        duration: info.durationSec,
        width: job.width,
        height: job.height,
        hasAudio: info.streams.some((s) => s.type === "audio"),
        context: translate("Project final video generated \"{0}\"", title),
        projectId,
      });
    } catch { /* ignore non-blocking registration */ }
  } catch (error) {
    // Keep `stage` as it was: it tells the UI which step it stopped or failed at.
    if (job.signal.aborted) {
      updateVideo(videoId, { status: "cancelled", error: null, finishedAt: new Date() });
      return;
    }
    console.error(`[video] ${videoId}:`, error);
    updateVideo(videoId, { status: "error", error: errorMessage(error), finishedAt: new Date() });
  }
}

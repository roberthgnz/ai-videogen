import type { Video } from "@/lib/db/schema";
import { expectedAudioHashes, sceneAudioError, sceneAudioStatus } from "@/lib/pipeline/steps/tts";
import { videoStep, videoView } from "@/lib/pipeline/steps/video";
import { listMusic, listSfx } from "@/lib/pipeline/audio/music";
import { candidateKey } from "@/lib/pipeline/steps/visuals";
import { getVisualProvider } from "@/lib/pipeline/visuals";
import type { ProjectWithRelations } from "@/lib/projects";
import { passesView } from "@/lib/editing/passes";
import type { EditorProject } from "./types";
import type { VideoInfo } from "./video-panel";

function toVideoInfo(raw: Video): VideoInfo {
  const v = videoView(raw);
  return {
    id: v.id,
    sceneId: v.sceneId,
    status: v.status,
    stage: v.stage,
    step: videoStep(v),
    progress: v.progress,
    format: v.format,
    width: v.width,
    height: v.height,
    durationSec: v.durationSec,
    loudnessLufs: v.loudnessLufs,
    expectedDurationSec: v.expectedDurationSec,
    error: v.error,
    url: v.outputPath && v.status === "done" ? `/api/files/${v.outputPath}?v=${v.updatedAt.getTime()}` : null,
    savedPath: v.status === "done" ? v.savedPath : null,
    createdAt: v.createdAt.toISOString(),
  };
}

/** Serializable view of a project for the editor and result pages. */
export function projectView(project: ProjectWithRelations): EditorProject {
  const hashes = expectedAudioHashes(project.scenes, project.voiceId);
  const provider = getVisualProvider();
  const videos = project.videos.map(toVideoInfo);
  const previews: Record<string, VideoInfo> = {};
  for (const v of videos) if (v.sceneId && !previews[v.sceneId]) previews[v.sceneId] = v; // newest first

  return {
    edit: project.edit,
    id: project.id,
    title: project.title,
    topic: project.topic,
    targetDurationSec: project.targetDurationSec,
    tone: project.tone,
    format: project.format,
    voiceId: project.voiceId,
    preset: project.preset,
    captionStyle: project.captionStyle,
    transition: project.transition,
    music: project.music,
    sfx: project.sfx,
    audioLibrary: { music: listMusic(), sfx: listSfx().length },
    scriptStatus: project.scriptStatus,
    scriptError: project.scriptError,
    scenes: project.scenes.map((s) => ({
      id: s.id,
      template: s.template,
      narration: s.narration,
      content: s.content,
      visualQueries: s.visualQueries,
    })),
    shots: Object.fromEntries(
      project.scenes.map((s) => [
        s.id,
        (s.shots ?? []).map((shot) => ({
          query: shot.query,
          manual: !!shot.manual,
          selectedKey: shot.selected ? candidateKey(shot.selected) : null,
          candidates: shot.candidates.map((c) => ({
            key: candidateKey(c),
            kind: c.kind,
            thumbUrl: c.thumbUrl,
            durationSec: c.durationSec,
            pageUrl: c.pageUrl,
            author: c.author,
          })),
        })),
      ]),
    ),
    visuals: { available: !!provider, credit: provider?.credit ?? null },
    audio: Object.fromEntries(
      project.scenes.map((s) => [
        s.id,
        {
          status: sceneAudioStatus(s, hashes[s.id]),
          // updatedAt busts the browser cache after a new take of the same text.
          url: s.audioPath ? `/api/files/${s.audioPath}?v=${s.updatedAt.getTime()}` : null,
          durationSec: s.audioDurationSec,
          words: s.words ?? [],
          error: sceneAudioError(s),
        },
      ]),
    ),
    videos: videos.filter((v) => !v.sceneId),
    previews,
    passes: passesView(project.id, project.edit),
  };
}

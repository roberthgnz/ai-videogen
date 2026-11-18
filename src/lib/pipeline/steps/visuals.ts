import { t as translate } from "@/lib/i18n";
import type { Scene } from "@/lib/db/schema";
import type { SceneShot, VideoFormat, VisualCandidate } from "@/lib/domain";
import { getProject, getScene, setSceneShots, setSceneVisualQueries, touchProject } from "@/lib/projects";
import { estimateSeconds } from "@/lib/script/schema";
import { theme } from "@/theme";
import { errorMessage, PipelineError } from "../errors";
import { getVisualProvider, type VisualProvider } from "../visuals";
import { ensureShotFile, hasShotFile, MIN_SOURCE_SEC, upscale } from "../visuals/media";
import { generateVisualQueries, type VisualQueryGenerator } from "../visuals/queries";
import { shotCount } from "../visuals/shots";

/** Candidates kept per shot for the picker. */
export const CANDIDATES_PER_SHOT = 12;
/** Below this many usable videos, photos are added so the picker is never empty. */
const MIN_VIDEO_CANDIDATES = 4;
const DOWNLOAD_CONCURRENCY = 4;

const keyOf = (c: Pick<VisualCandidate, "provider" | "id">) => `${c.provider}:${c.id}`;

/** A video long enough to fill a shot, or any image. */
function usable(candidate: VisualCandidate): boolean {
  return candidate.kind === "image" || (candidate.durationSec ?? 0) >= MIN_SOURCE_SEC;
}

/** Scene length the shots must cover: the real audio when it exists, an estimate before. */
export function sceneVisualDuration(scene: Pick<Scene, "audioDurationSec" | "narration">): number {
  const speech = scene.audioDurationSec ?? estimateSeconds(scene.narration);
  return theme.timing.sceneLead + speech + theme.timing.sceneTail;
}

/** An upscale beyond this looks soft at full screen. */
const MAX_SHARP_UPSCALE = 1.5;

/**
 * Best first: on-topic before off-topic, then assets that fill the frame
 * natively, then ones that survive the crop, then soft ones. The provider's
 * own order (popularity) breaks ties.
 */
export function rankCandidates(candidates: VisualCandidate[], format: VideoFormat): VisualCandidate[] {
  const vertical = format === "vertical";
  const score = (c: VisualCandidate) => {
    const relevance = c.relevance ?? 1;
    const offTopic = relevance >= 0.5 ? 0 : relevance > 0 ? 1 : 2;
    const scale = upscale(c, format);
    const fit = c.height > c.width === vertical && scale <= 1.05 ? 0 : scale <= MAX_SHARP_UPSCALE ? 1 : 2;
    return offTopic * 10 + fit - relevance;
  };
  return candidates
    .map((candidate, index) => ({ candidate, index, score: score(candidate) }))
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map((x) => x.candidate);
}

/** Ranked videos for a query, topped up with photos when few are good. */
export async function findCandidates(
  provider: VisualProvider,
  query: string,
  format: VideoFormat,
  signal?: AbortSignal,
): Promise<VisualCandidate[]> {
  const videos = rankCandidates((await provider.search({ query, kind: "video", format, limit: 30, signal })).filter(usable), format);
  const good = videos.filter((c) => (c.relevance ?? 1) >= 0.5).length;
  if (good >= MIN_VIDEO_CANDIDATES || !provider.kinds.includes("image")) return videos;
  const images = await provider.search({ query, kind: "image", format, limit: CANDIDATES_PER_SHOT, signal });
  return rankCandidates([...videos, ...images], format);
}

/** First candidate not used elsewhere in the project (falls back to the first). */
function pickUnused(candidates: VisualCandidate[], used: Set<string>): VisualCandidate | null {
  return candidates.find((c) => !used.has(keyOf(c))) ?? candidates[0] ?? null;
}

/** The picker list: the top results, always including the selected one. */
function shortlist(candidates: VisualCandidate[], selected: VisualCandidate | null): VisualCandidate[] {
  const top = candidates.slice(0, CANDIDATES_PER_SHOT);
  if (selected && !top.some((c) => keyOf(c) === keyOf(selected))) top[top.length - 1] = selected;
  return top;
}

export interface VisualsOptions {
  /** Frame the assets are chosen and cropped for (default: the project's). */
  format?: VideoFormat;
  /** Only these scenes (a preview). */
  sceneIds?: string[];
  /** Download and normalize the chosen assets (needed before composing). */
  download?: boolean;
  /** Search again even for shots that already have an asset (hand-picked ones are still kept). */
  refresh?: boolean;
  provider?: VisualProvider | null;
  queryGenerator?: VisualQueryGenerator;
  /** Injected in tests instead of the ffmpeg download. */
  ensureFile?: typeof ensureShotFile;
  signal?: AbortSignal;
}

export type VisualsResult =
  | { ok: true; skipped?: "no-provider"; shots: number }
  | { ok: false; error: string };

/**
 * B-roll step: every scene gets one asset per 2-4 s shot. Searches come from
 * the script (generated here for scenes without any), each shot takes the
 * best result nobody else in the video uses, and shots chosen by hand or
 * still matching their search are kept. Without a provider the step is
 * skipped and scenes keep the animated background.
 */
export async function runVisualsForProject(projectId: string, options: VisualsOptions = {}): Promise<VisualsResult> {
  try {
    const project = getProject(projectId);
    if (!project) return { ok: false, error: translate("Project not found.") };
    const provider = options.provider === undefined ? getVisualProvider() : options.provider;
    if (!provider) return { ok: true, skipped: "no-provider", shots: 0 };

    const format = options.format ?? project.format;
    const targets = options.sceneIds ? project.scenes.filter((s) => options.sceneIds!.includes(s.id)) : project.scenes;

    // 1. Searches for scenes that have none.
    const queries = new Map(project.scenes.map((s) => [s.id, s.visualQueries.filter((q) => q.trim())]));
    const missing = targets.filter((s) => queries.get(s.id)!.length === 0 && s.narration.trim());
    if (missing.length) {
      const generated = await (options.queryGenerator ?? generateVisualQueries)(
        {
          title: project.title || project.topic,
          scenes: missing.map((s) => ({ narration: s.narration, onScreen: Object.values(s.content).flat().filter(Boolean).join(" · ") })),
        },
        { signal: options.signal },
      );
      missing.forEach((scene, i) => {
        queries.set(scene.id, generated[i]);
        setSceneVisualQueries(scene.id, generated[i]);
      });
      touchProject(projectId);
    }

    // 2. One asset per shot, never the same asset twice in a video.
    const used = new Set<string>();
    for (const scene of project.scenes) {
      for (const shot of scene.shots ?? []) if (shot.selected) used.add(keyOf(shot.selected));
    }
    const searches = new Map<string, Promise<VisualCandidate[]>>();
    const search = (query: string) => {
      let pending = searches.get(query);
      if (!pending) searches.set(query, (pending = findCandidates(provider, query, format, options.signal)));
      return pending;
    };

    const result = new Map<string, SceneShot[]>();
    for (const scene of targets) {
      const sceneQueries = queries.get(scene.id) ?? [];
      if (sceneQueries.length === 0) continue;
      const count = shotCount(sceneVisualDuration(scene));
      const previous = scene.shots ?? [];
      const shots: SceneShot[] = [];
      for (let i = 0; i < count; i++) {
        const query = sceneQueries[i % sceneQueries.length];
        const kept = previous[i];
        if (kept?.selected && (kept.manual || (kept.query === query && !options.refresh))) {
          shots.push(kept);
          continue;
        }
        if (kept?.selected) used.delete(keyOf(kept.selected));
        const candidates = await search(query);
        const selected = pickUnused(candidates, used);
        if (selected) used.add(keyOf(selected));
        shots.push({ query, selected, candidates: shortlist(candidates, selected) });
      }
      result.set(scene.id, shots);
      setSceneShots(scene.id, shots);
    }

    // 3. Files on disk, replacing an asset that cannot be downloaded with the next candidate.
    if (options.download) {
      const ensure = options.ensureFile ?? ensureShotFile;
      const jobs = [...result].flatMap(([sceneId, shots]) => shots.map((shot, index) => ({ sceneId, shots, shot, index })));
      let next = 0;
      const worker = async () => {
        while (next < jobs.length) {
          const job = jobs[next++];
          const tried = new Set<string>();
          let candidate = job.shot.selected;
          let lastError: unknown;
          while (candidate && tried.size < 3) {
            tried.add(keyOf(candidate));
            try {
              await ensure(candidate, format, options.signal);
              break;
            } catch (error) {
              if (options.signal?.aborted) throw error;
              lastError = error;
              console.error(`[visuals] ${keyOf(candidate)}:`, errorMessage(error));
              used.delete(keyOf(candidate));
              candidate = job.shot.candidates.find((c) => !tried.has(keyOf(c)) && !used.has(keyOf(c))) ?? null;
              if (candidate) used.add(keyOf(candidate));
            }
          }
          if (candidate !== job.shot.selected) {
            if (!candidate && lastError) throw lastError;
            job.shots[job.index] = { ...job.shot, selected: candidate };
            setSceneShots(job.sceneId, job.shots);
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, jobs.length) }, worker));
    }

    return { ok: true, shots: [...result.values()].reduce((sum, shots) => sum + shots.filter((s) => s.selected).length, 0) };
  } catch (error) {
    console.error(`[visuals] project ${projectId}:`, error);
    return { ok: false, error: errorMessage(error) };
  }
}

type ShotResult = { ok: true; shot: SceneShot } | { ok: false; error: string };

function loadShot(sceneId: string, index: number): { scene: Scene; shots: SceneShot[] } {
  const scene = getScene(sceneId);
  if (!scene) throw new PipelineError("visuals", translate("Scene not found."));
  const shots = [...(scene.shots ?? [])];
  if (index < 0 || index >= Math.max(shots.length, shotCount(sceneVisualDuration(scene)))) {
    throw new PipelineError("visuals", translate("Not found."));
  }
  return { scene, shots };
}

/** New search for one shot, typed by the user: fresh candidates, best one selected. */
export async function searchShot(
  sceneId: string,
  index: number,
  query: string,
  options: { format?: VideoFormat; provider?: VisualProvider | null } = {},
): Promise<ShotResult> {
  try {
    const provider = options.provider === undefined ? getVisualProvider() : options.provider;
    if (!provider) throw new PipelineError("visuals", translate("PIXABAY_API_KEY missing in .env.loc."));
    const text = query.trim();
    if (!text) throw new PipelineError("visuals", translate("Write what to look for."));
    const { scene, shots } = loadShot(sceneId, index);
    const project = getProject(scene.projectId)!;
    const candidates = await findCandidates(provider, text, options.format ?? project.format);
    if (candidates.length === 0) throw new PipelineError("visuals", translate("No results for \"{0}.\" Try with other words.", text));

    const used = new Set<string>();
    for (const other of project.scenes) {
      (other.shots ?? []).forEach((s, i) => {
        if (s.selected && !(other.id === sceneId && i === index)) used.add(keyOf(s.selected));
      });
    }
    const selected = pickUnused(candidates, used);
    const shot: SceneShot = { query: text, selected, candidates: shortlist(candidates, selected), manual: true };
    while (shots.length < index) shots.push({ query: text, selected: null, candidates: [] });
    shots[index] = shot;
    setSceneShots(sceneId, shots);
    return { ok: true, shot };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

/** The user picks one of a shot's candidates. */
export function pickShot(sceneId: string, index: number, candidateKey: string): ShotResult {
  try {
    const { shots } = loadShot(sceneId, index);
    const current = shots[index];
    const selected = current?.candidates.find((c) => keyOf(c) === candidateKey);
    if (!current || !selected) throw new PipelineError("visuals", translate("That result is no longer available; it looks again."));
    const shot: SceneShot = { ...current, selected, manual: true };
    shots[index] = shot;
    setSceneShots(sceneId, shots);
    return { ok: true, shot };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

/** Selected assets of a scene that are already on disk for this format, in shot order. */
export function readyShots(scene: Pick<Scene, "shots">, format: VideoFormat): VisualCandidate[] {
  return (scene.shots ?? [])
    .map((s) => s.selected)
    .filter((c): c is VisualCandidate => !!c && hasShotFile(c, format));
}

export { keyOf as candidateKey };

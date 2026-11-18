import { t as translate } from "@/lib/i18n";
import type { EditorProject } from "../types";

export type StepState = "done" | "running" | "error" | "pending";

export interface PipelineStepView {
  key: "script" | "tts" | "visuals" | "compose" | "render";
  label: string;
  state: StepState;
  detail: string;
  error: string | null;
}

const ORDER = ["tts", "visuals", "compose", "render"] as const;
const inProgress = (s: string) => s === "queued" || s === "composing" || s === "rendering";

/** Status of each pipeline step, from the project and its latest full video. */
export function pipelineSteps(project: EditorProject): PipelineStepView[] {
  if (project.edit.enabled) {
    const latest = project.videos[0];
    const busy = !!latest && inProgress(latest.status);
    const composing = busy && latest.step === "compose";
    return [
      { key: "script", label: translate("Editable timeline"), state: project.edit.clips.length || project.edit.overlays.length ? "done" : "pending", detail: translate("{0} clips · {1} texts and subtitles", project.edit.clips.length, project.edit.overlays.length), error: null },
      { key: "compose", label: translate("Composition"), state: composing ? "running" : latest?.step === "compose" && latest.status === "error" ? "error" : latest && (latest.step === "render" || latest.status === "done") ? "done" : "pending", detail: translate("Leading, audio and position of the canvas"), error: latest?.step === "compose" && latest.status === "error" ? latest.error : null },
      { key: "render", label: translate("Surrender and verification"), state: latest?.status === "done" ? "done" : latest?.status === "error" && latest.step === "render" ? "error" : busy && !composing ? "running" : "pending", detail: latest?.status === "done" ? `${latest.width}×${latest.height} · ${latest.durationSec?.toFixed(2)} s` : busy ? `${Math.round(latest.progress)}%` : "—", error: latest?.step === "render" && latest.status === "error" ? latest.error : null },
    ];
  }
  const scenes = project.scenes.length;
  const script: PipelineStepView = {
    key: "script",
    label: translate("Script"),
    state:
      project.scriptStatus === "error"
        ? "error"
        : project.scriptStatus === "running"
          ? "running"
          : scenes > 0
            ? "done"
            : "pending",
    detail: scenes > 0 ? translate("{0} scenes", scenes) : translate("No script"),
    error: project.scriptStatus === "error" ? project.scriptError : null,
  };

  const audio = Object.values(project.audio);
  const ready = audio.filter((a) => a.status === "ready").length;
  const audioErrors = audio.filter((a) => a.status === "error");
  const latest = project.videos[0];
  const latestIdx = latest ? ORDER.indexOf(latest.step) : -1;

  const fromVideo = (key: (typeof ORDER)[number]): { state: StepState; error: string | null } | null => {
    if (!latest) return null;
    const idx = ORDER.indexOf(key);
    if (latest.status === "done") return { state: "done", error: null };
    if (idx < latestIdx) return { state: "done", error: null };
    if (idx > latestIdx) return { state: "pending", error: null };
    if (latest.status === "error") return { state: "error", error: latest.error };
    // A cancelled video leaves its step pending: stopping it was the user's choice, not a failure.
    return inProgress(latest.status) ? { state: "running", error: null } : null;
  };

  const ttsFromVideo = fromVideo("tts");
  const tts: PipelineStepView = {
    key: "tts",
    label: translate("Voice"),
    state:
      ttsFromVideo?.state === "running" || audio.some((a) => a.status === "running")
        ? "running"
        : ttsFromVideo?.state === "error"
          ? "error"
          : scenes > 0 && ready === scenes
            ? "done"
            : audioErrors.length
              ? "error"
              : "pending",
    detail: translate("{0} / {1} scenes with audio", ready, scenes),
    error:
      ttsFromVideo?.error ??
      (audioErrors.length ? audioErrors.map((a) => a.error).filter(Boolean).join("\n") || null : null),
  };

  const visuals = fromVideo("visuals");
  const shotCount = Object.values(project.shots).reduce((sum, shots) => sum + shots.filter((s) => s.selectedKey).length, 0);
  const compose = fromVideo("compose");
  const render = fromVideo("render");
  return [
    script,
    tts,
    {
      key: "visuals",
      label: "B-roll",
      state: visuals?.state ?? (shotCount > 0 ? "done" : "pending"),
      detail: !project.visuals.available
        ? translate("No supplier (missing PIXABAY_API_KEY): animated background")
        : shotCount > 0
          ? translate("{0} shots", shotCount)
          : translate("Unsearched"),
      error: visuals?.error ?? null,
    },
    {
      key: "compose",
      label: translate("Composition"),
      state: compose?.state ?? "pending",
      detail: latest?.expectedDurationSec ? translate("{0} s, audio-marked duration", latest.expectedDurationSec.toFixed(2)) : "—",
      error: compose?.error ?? null,
    },
    {
      key: "render",
      label: translate("Surrender and verification"),
      state: render?.state ?? "pending",
      detail:
        latest?.status === "done" && latest.durationSec != null
          ? translate("{0} × {1} · {2} s · video + audio verified {3}", latest.width, latest.height, latest.durationSec.toFixed(2), latest.loudnessLufs != null ? ` · ${latest.loudnessLufs.toFixed(1)} LUFS` : "")
          : latest && inProgress(latest.status) && latest.step === "render"
            ? `${Math.round(latest.progress)}%`
            : latest?.status === "cancelled"
              ? translate("Cancelled")
              : "—",
      error: render?.error ?? null,
    },
  ];
}

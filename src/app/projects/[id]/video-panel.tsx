"use client";

import { t as translate, localizedLabels, getLocale } from "@/lib/i18n";
import { Collapsible } from "radix-ui";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Select, SelectItem } from "@/components/ui/select";
import type { VideoFormat, VideoStatus } from "@/lib/domain";
import { cancelVideoAction, startVideoAction } from "./actions";

export interface VideoInfo {
  id: string;
  /** Set for single-scene previews. */
  sceneId: string | null;
  status: VideoStatus;
  /** Pipeline step it is in, or failed at. */
  step: "tts" | "visuals" | "compose" | "render";
  stage: string | null;
  progress: number;
  format: VideoFormat;
  width: number;
  height: number;
  durationSec: number | null;
  /** Integrated loudness of the finished MP4, LUFS. */
  loudnessLufs: number | null;
  expectedDurationSec: number | null;
  error: string | null;
  url: string | null;
  /** Where the export was also saved on this computer, when the user chose a place. */
  savedPath: string | null;
  createdAt: string;
}

export const STAGES: Record<string, string> = localizedLabels((translate) => ({
  tts: translate("Generating the voice"),
  visuals: "Buscando y descargando el b-roll",
  compose: translate("Composing the scenes"),
  compile: translate("Compiling the composition"),
  extract_video: translate("Preparing means"),
  process_audio: "Procesando audio",
  start_browsers: "Arrancando el navegador",
  capture: "Capturando fotogramas",
  encode: translate("Encoding video"),
  assemble: "Montando el MP4",
  normalize: "Normalizando el volumen",
  save: translate("By saving in your folder"),
  done: translate("Finished"),
}));

const QUALITIES = localizedLabels((translate) => ([
  ["draft", translate("Draft (fast)")],
  ["looks", "Normal"],
  ["delivery", "Alta (final)"],
] as const));

const formatDate = (value: Date | number) => new Intl.DateTimeFormat(getLocale(), { dateStyle: "short", timeStyle: "short" }).format(value);

/** Render controls, live progress and the rendered versions of the project. */
export function VideoPanel({
  projectId,
  format,
  videos,
  blocked,
}: {
  projectId: string;
  format: VideoFormat;
  videos: VideoInfo[];
  /** Why rendering is not possible right now, or null. */
  blocked: string | null;
}) {
  const router = useRouter();
  const [quality, setQuality] = useState<(typeof QUALITIES)[number][0]>("looks");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const running = videos.find((v) => v.status === "composing" || v.status === "rendering" || v.status === "queued");
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => router.refresh(), 1000);
    return () => clearInterval(timer);
  }, [running, router]);

  function render() {
    setError(null);
    startTransition(async () => {
      const result = await startVideoAction(projectId, { format, quality });
      if (!result.ok) setError(result.error);
    });
  }

  const latestDone = videos.find((v) => v.status === "done");

  return (
    <section className="glass space-y-4 rounded-3xl p-5">
      <div className="flex flex-wrap items-center gap-3">
        <div className="mr-auto">
          <h2 className="text-lg font-semibold">{translate("Video")}</h2>
          <p className="text-sm text-muted">{format === "vertical" ? "1080×1920 (9:16)" : "1920×1080 (16:9)"}{translate("· local render with HyperFrames")}</p>
        </div>
        {blocked && <span className="text-sm text-muted">{blocked}</span>}
        <Select aria-label={translate("Quality")} value={quality} onValueChange={(v) => setQuality(v as typeof quality)} className="!w-44">
          {QUALITIES.map(([value, label]) => (
            <SelectItem key={value} value={value}>
              {label}
            </SelectItem>
          ))}
        </Select>
        <Button variant="primary" onClick={render} disabled={pending || !!running || !!blocked}>
          {running ? translate("Rendering…") : latestDone ? translate("Generate again") : translate("Generate video")}
        </Button>
      </div>

      {error && (
        <pre role="alert" className="whitespace-pre-wrap rounded-xl bg-danger/10 p-3 font-mono text-xs text-danger">
          {error}
        </pre>
      )}

      {running && (
        <div className="space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span>{STAGES[running.stage ?? ""] ?? (running.status === "composing" ? "Componiendo" : translate("Rendering"))}</span>
            {running.status === "rendering" && <span className="font-mono">{Math.round(running.progress)}%</span>}
          </div>
          <Progress value={running.status === "rendering" ? running.progress : null} className="h-1.5" label={translate("Render progress")} />
          <Button size="sm" className="text-muted hover:text-foreground" onClick={() => startTransition(async () => void (await cancelVideoAction(running.id)))}>{translate("Cancel")}</Button>
        </div>
      )}

      {latestDone?.url && (
        <div className="flex flex-col items-center gap-3">
          <video
            key={latestDone.id}
            src={latestDone.url}
            controls
            preload="metadata"
            className={`rounded-2xl border border-border bg-black ${latestDone.format === "vertical" ? "max-h-[70vh]" : "w-full"}`}
          />
          <Button asChild variant="outline">
            <a href={`${latestDone.url}&download=1`}>{translate("Download MP4")}</a>
          </Button>
        </div>
      )}

      {videos.length > 0 && (
        <Collapsible.Root className="text-sm">
          <Collapsible.Trigger className="group inline-flex items-center gap-1 text-muted hover:text-foreground">
            <span aria-hidden className="transition group-data-[state=open]:rotate-90">
              ›
            </span>{translate("Versions")}{videos.length})
          </Collapsible.Trigger>
          <Collapsible.Content>
            <ul className="mt-2 space-y-2">
              {videos.map((v) => (
                <li key={v.id} className="rounded-xl border border-border bg-surface p-2.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs text-muted">{formatDate(new Date(v.createdAt))}</span>
                    <span>
                      {v.width}×{v.height}
                    </span>
                    <StatusLabel status={v.status} />
                    {v.durationSec != null && <span className="text-muted">{v.durationSec.toFixed(2)}s</span>}
                    {v.loudnessLufs != null && <span className="text-muted">{v.loudnessLufs.toFixed(1)} LUFS</span>}
                    {v.url && v.status === "done" && (
                      <a href={`${v.url}&download=1`} className="ml-auto text-accent hover:underline">{translate("Download")}</a>
                    )}
                  </div>
                  {v.error && <pre className="mt-2 whitespace-pre-wrap font-mono text-xs text-danger">{v.error}</pre>}
                </li>
              ))}
            </ul>
          </Collapsible.Content>
        </Collapsible.Root>
      )}
    </section>
  );
}

function StatusLabel({ status }: { status: VideoStatus }) {
  const map: Record<VideoStatus, [string, string]> = {
    queued: ["En cola", "text-muted"],
    composing: ["Componiendo", "text-accent"],
    rendering: [translate("Rendering"), "text-accent"],
    done: [translate("Ready"), "text-emerald-600"],
    error: ["Error", "text-danger"],
    cancelled: [translate("Cancelled"), "text-muted"],
  };
  const [label, cls] = map[status];
  return <span className={cls}>{label}</span>;
}

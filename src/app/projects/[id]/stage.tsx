"use client";

import { t as translate } from "@/lib/i18n";
import { Button, IconButton } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Toggle } from "@/components/ui/toggle-group";
import { Tooltip } from "@/components/ui/tooltip";
import type { VideoFormat } from "@/lib/domain";
import { formatClock } from "./timeline-math";

export interface StageSource {
  id: string;
  url: string;
  /** "scene" = the draft preview of one scene, not the whole video. */
  kind: "full" | "scene";
}

/**
 * The big preview: the latest rendered video (or the selected scene's draft),
 * with render progress over it. Empty, it shows the scene's b-roll as a poster.
 */
export function Stage({
  format,
  source,
  poster,
  videoRef,
  onPlayingChange,
  onEnded,
  onDuration,
  loop,
  muted,
  caption,
  progress,
  empty,
}: {
  format: VideoFormat;
  source: StageSource | null;
  poster: string | null;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  onPlayingChange: (playing: boolean) => void;
  onEnded: () => void;
  onDuration: (seconds: number | null) => void;
  loop: boolean;
  muted: boolean;
  /** Small label over the frame (what is being shown). */
  caption: string | null;
  progress: { label: string; percent: number | null; onCancel: (() => void) | null } | null;
  /** Shown over the frame when there is nothing to play. */
  empty: React.ReactNode;
}) {
  const vertical = format === "vertical";
  return (
    <div className="relative flex min-h-0 flex-1 items-center justify-center px-4 pt-2 sm:px-6">
      <div
        className={`stage-frame relative max-h-full max-w-full overflow-hidden rounded-[22px] bg-black ${
          vertical ? "aspect-[9/16] h-full" : "aspect-video h-full"
        }`}
      >
        {source ? (
          <video
            key={source.id}
            ref={videoRef}
            src={source.url}
            preload="auto"
            playsInline
            loop={loop}
            muted={muted}
            onPlay={() => onPlayingChange(true)}
            onPause={() => onPlayingChange(false)}
            onEnded={onEnded}
            onLoadedMetadata={(e) => onDuration(Number.isFinite(e.currentTarget.duration) ? e.currentTarget.duration : null)}
            onClick={(e) => (e.currentTarget.paused ? void e.currentTarget.play() : e.currentTarget.pause())}
            className="h-full w-full cursor-pointer object-contain"
          />
        ) : (
          <>
            {poster && (
              // eslint-disable-next-line @next/next/no-img-element -- remote stock thumbnail, not an app asset
              <img src={poster} alt="" className="h-full w-full scale-105 object-cover opacity-45 blur-[2px]" />
            )}
            <div className="absolute inset-0 flex items-center justify-center p-6 text-center">{empty}</div>
          </>
        )}

        {caption && (
          <span className="glass-chip pointer-events-none absolute left-3 top-3 !cursor-default !px-2.5 !py-1 text-xs">{caption}</span>
        )}

        {progress && (
          <div className="glass-strong absolute inset-x-3 bottom-3 space-y-1.5 rounded-2xl px-3.5 py-2.5" role="status">
            <div className="flex items-center gap-2 text-xs">
              <span className="typing-dot text-accent" aria-hidden />
              <span className="mr-auto truncate">{progress.label}</span>
              {progress.percent != null && <span className="font-mono">{Math.round(progress.percent)}%</span>}
              {progress.onCancel && (
                <Button variant="ghost" size="sm" className="-my-1 h-6 px-2 text-muted" onClick={progress.onCancel}>{translate("Cancel")}</Button>
              )}
            </div>
            <Progress value={progress.percent} label={progress.label} />
          </div>
        )}
      </div>
    </div>
  );
}

/** Player controls under the stage, Flow-style: mute, clock, prev/play/next, length, fullscreen, loop. */
export function Transport({
  time,
  total,
  playing,
  canPlay,
  muted,
  loop,
  onPlay,
  onPrev,
  onNext,
  onMute,
  onLoop,
  onFullscreen,
}: {
  time: number;
  total: number;
  playing: boolean;
  canPlay: boolean;
  muted: boolean;
  loop: boolean;
  onPlay: () => void;
  onPrev: () => void;
  onNext: () => void;
  onMute: (muted: boolean) => void;
  onLoop: (loop: boolean) => void;
  onFullscreen: () => void;
}) {
  return (
    <div className="flex h-14 flex-none items-center justify-center gap-1.5 sm:gap-3" role="group" aria-label={translate("Reproduction")}>
      <Tooltip content={muted ? "Activar sonido" : translate("Mute")}>
        <Toggle pressed={muted} onPressedChange={onMute} disabled={!canPlay} aria-label={translate("Mute")}>
          <SpeakerIcon muted={muted} />
        </Toggle>
      </Tooltip>
      <span className="w-[72px] text-right font-mono text-[13px] tabular-nums">{formatClock(time)}</span>
      <IconButton label={translate("Previous scene")} tooltipSide="top" onClick={onPrev}>
        <SkipIcon dir="back" />
      </IconButton>
      <Button
        variant="primary"
        size="icon-lg"
        onClick={onPlay}
        disabled={!canPlay}
        aria-label={playing ? translate("Pause") : translate("Play")}
        className="shadow-[0_4px_18px_rgba(255,255,255,0.18)] hover:scale-105"
      >
        {playing ? <PauseIcon /> : <PlayIcon />}
      </Button>
      <IconButton label={translate("Next scene")} tooltipSide="top" onClick={onNext}>
        <SkipIcon dir="next" />
      </IconButton>
      <span className="w-[72px] font-mono text-[13px] tabular-nums text-muted">{formatClock(total)}</span>
      <IconButton label={translate("Full screen")} tooltipSide="top" onClick={onFullscreen} disabled={!canPlay}>
        <FullscreenIcon />
      </IconButton>
      <Tooltip content={translate("Repeat")} side="top">
        <Toggle pressed={loop} onPressedChange={onLoop} aria-label={translate("Repeat")}>
          <LoopIcon />
        </Toggle>
      </Tooltip>
    </div>
  );
}

const svg = { width: 18, height: 18, viewBox: "0 0 24 24", "aria-hidden": true } as const;

function PlayIcon() {
  return (
    <svg {...svg} fill="currentColor">
      <path d="M8 5.5v13a1 1 0 001.5.86l10.5-6.5a1 1 0 000-1.72L9.5 4.64A1 1 0 008 5.5z" />
    </svg>
  );
}
function PauseIcon() {
  return (
    <svg {...svg} fill="currentColor">
      <rect x="6.5" y="5" width="4" height="14" rx="1" />
      <rect x="13.5" y="5" width="4" height="14" rx="1" />
    </svg>
  );
}
function SkipIcon({ dir }: { dir: "back" | "next" }) {
  return (
    <svg {...svg} fill="currentColor" style={dir === "back" ? { transform: "scaleX(-1)" } : undefined}>
      <path d="M6 6.2v11.6a.8.8 0 001.2.7l8.6-5.8a.8.8 0 000-1.4L7.2 5.5a.8.8 0 00-1.2.7z" />
      <rect x="16.5" y="5.5" width="2.2" height="13" rx="0.8" />
    </svg>
  );
}
function SpeakerIcon({ muted }: { muted: boolean }) {
  return (
    <svg {...svg} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor" />
      {muted ? <path d="M16 9.5l5 5M21 9.5l-5 5" /> : <path d="M15.5 9a4 4 0 010 6M18.5 6.5a7.5 7.5 0 010 11" />}
    </svg>
  );
}
function FullscreenIcon() {
  return (
    <svg {...svg} fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
    </svg>
  );
}
function LoopIcon() {
  return (
    <svg {...svg} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 2.5l3 3-3 3" />
      <path d="M4 11.5V10a4.5 4.5 0 014.5-4.5H20" />
      <path d="M7 21.5l-3-3 3-3" />
      <path d="M20 12.5V14a4.5 4.5 0 01-4.5 4.5H4" />
    </svg>
  );
}

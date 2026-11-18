"use client";

import { t as translate, localizedLabels } from "@/lib/i18n";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AudioStatus } from "@/lib/domain";
import { ToggleGroup, Toolbar } from "radix-ui";
import { Button, IconButton } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { rulerStep, totalOf, type Span } from "./timeline-math";

export interface Clip {
  key: string;
  /** Short text to recognise the scene: its on-screen text or the start of the narration. */
  label: string;
  thumbs: string[];
  audio: AudioStatus | "unsaved";
  hasIssues: boolean;
}

const TILE = 76;
const MIN_PX = 6;
const MAX_PX = 400;
/** Space after the last clip for the "+" button and some air. */
const TAIL_PX = 96;

const AUDIO_BAR: Record<Clip["audio"], string> = {
  ready: "bg-emerald-400/80",
  stale: "bg-amber-400/80",
  running: "bg-accent animate-pulse",
  error: "bg-danger",
  none: "bg-white/15",
  unsaved: "bg-amber-400/50",
};

const AUDIO_LABEL: Record<Clip["audio"], string> = localizedLabels((translate) => ({
  ready: translate("voice ready"),
  stale: translate("Unupdated voice"),
  running: translate("generating the voice"),
  error: translate("voice error"),
  none: translate("No voice"),
  unsaved: translate("unsaved"),
}));

/**
 * One clip per scene, as wide as it lasts, with its b-roll as a film strip.
 * Click a clip to select it (the side panel opens it); click or drag on the
 * ruler to move the playhead.
 */
export function Timeline({
  clips,
  spans,
  selected,
  time,
  onSelect,
  onSeek,
  onAdd,
  canAdd,
  onMove,
  onRemove,
  onPreview,
  previewState,
  readOnly,
}: {
  clips: Clip[];
  spans: Span[];
  selected: number;
  time: number;
  onSelect: (index: number) => void;
  onSeek: (t: number) => void;
  onAdd: () => void;
  canAdd: boolean;
  onMove: (delta: -1 | 1) => void;
  onRemove: () => void;
  onPreview: () => void;
  previewState: { can: boolean; running: boolean; ready: boolean } | null;
  readOnly: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const total = totalOf(spans);
  const [px, setPx] = useState<number | null>(null);
  const [width, setWidth] = useState(0);

  // Fit the whole video in view until the user zooms.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  const fit = total > 0 && width > 0 ? clamp((width - TAIL_PX - 24) / total, MIN_PX, MAX_PX) : 40;
  const pxPerSec = px ?? fit;
  const contentWidth = Math.max(width, total * pxPerSec + TAIL_PX + 24);
  const step = rulerStep(pxPerSec);
  const marks = Array.from({ length: Math.floor(contentWidth / pxPerSec / step) + 1 }, (_, i) => i * step);

  // Keep the playhead in view while it moves.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const x = 12 + time * pxPerSec;
    if (x < el.scrollLeft + 24 || x > el.scrollLeft + el.clientWidth - 48) el.scrollLeft = Math.max(0, x - el.clientWidth / 3);
  }, [time, pxPerSec]);

  function seekFromPointer(e: React.PointerEvent<HTMLDivElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    onSeek(clamp((e.clientX - rect.left - 12) / pxPerSec, 0, total));
  }

  const zoom = (factor: number) => setPx(clamp(pxPerSec * factor, MIN_PX, MAX_PX));
  const sel = selected >= 0 ? clips[selected] : undefined;

  return (
    <section aria-label={translate("Timeline")} className="flex flex-col">
      <Toolbar.Root aria-label={translate("Time line tools")} className="flex h-10 items-center gap-1 px-3">
        {sel ? (
          <>
            <span className="mr-1 text-xs text-muted">{translate("Scene")} {selected + 1}</span>
            <Toolbar.Button asChild>
              <IconButton label={translate("Move left")} disabled={readOnly || selected === 0} onClick={() => onMove(-1)}>
                <Chevron dir="left" />
              </IconButton>
            </Toolbar.Button>
            <Toolbar.Button asChild>
              <IconButton label={translate("Move right")} disabled={readOnly || selected === clips.length - 1} onClick={() => onMove(1)}>
                <Chevron dir="right" />
              </IconButton>
            </Toolbar.Button>
            <Toolbar.Button asChild>
              <IconButton label={translate("Remove Scene")} disabled={readOnly} onClick={onRemove}>
                <TrashIcon />
              </IconButton>
            </Toolbar.Button>
            {previewState && (
              <Toolbar.Button asChild>
                <Button
                  size="sm"
                  onClick={onPreview}
                  disabled={!previewState.can || previewState.running}
                  title={previewState.can ? translate("Renderize only this scene in draft") : translate("Save the changes and generate your voice so you can preview it")}
                  className="ml-1"
                >
                  {previewState.running ? translate("Renderating scene…") : previewState.ready ? translate("Redo preview") : translate("Preview of the scene")}
                </Button>
              </Toolbar.Button>
            )}
          </>
        ) : (
          <span className="text-xs text-muted">
            {clips.length > 0 ? translate("{0} scenes · press one to edit it", clips.length) : translate("No scenes yet")}
          </span>
        )}
        <div className="ml-auto flex items-center gap-0.5">
          <Toolbar.Button asChild>
            <IconButton label={translate("Zoom out")} disabled={pxPerSec <= MIN_PX} onClick={() => zoom(1 / 1.5)}>
              <ZoomIcon out />
            </IconButton>
          </Toolbar.Button>
          <Toolbar.Button asChild>
            <IconButton label={translate("Zoom in")} disabled={pxPerSec >= MAX_PX} onClick={() => zoom(1.5)}>
              <ZoomIcon />
            </IconButton>
          </Toolbar.Button>
        </div>
      </Toolbar.Root>

      <div ref={scrollRef} className="timeline-scroll relative overflow-x-auto overflow-y-hidden border-y border-white/[0.06] bg-white/[0.025]">
        <div className="relative" style={{ width: contentWidth }}>
          {/* Ruler: click or drag to seek. */}
          <div
            className="relative h-7 cursor-ew-resize select-none border-b border-white/[0.06]"
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              seekFromPointer(e);
            }}
            onPointerMove={(e) => {
              if (e.currentTarget.hasPointerCapture(e.pointerId)) seekFromPointer(e);
            }}
          >
            {marks.map((s) => (
              <span
                key={s}
                className="absolute top-0 h-full border-l border-white/[0.07] pl-1 pt-1 font-mono text-[10px] leading-none text-muted"
                style={{ left: 12 + s * pxPerSec }}
              >
                {formatMark(s)}
              </span>
            ))}
          </div>

          {/* Track */}
          <div className="relative h-[84px]">
            {marks.map((s) => (
              <span key={s} aria-hidden className="absolute inset-y-0 border-l border-white/[0.05]" style={{ left: 12 + s * pxPerSec }} />
            ))}
            {/* Clips are a single-select toggle group: arrow keys move between them, Enter/Space selects. */}
            <ToggleGroup.Root
              asChild
              type="single"
              loop={false}
              value={sel?.key ?? ""}
              onValueChange={(key) => onSelect(key ? clips.findIndex((c) => c.key === key) : selected)}
              aria-label={translate("Scenes")}
            >
            <ol className="absolute inset-y-0 left-3 flex items-center">
              {clips.map((clip, i) => {
                const w = Math.max(18, spans[i].duration * pxPerSec - 3);
                const tiles = clip.thumbs.length > 0 ? Math.ceil(w / TILE) : 0;
                const active = i === selected;
                return (
                  <li key={clip.key} style={{ width: spans[i].duration * pxPerSec }} className="flex h-full items-center">
                    <ToggleGroup.Item value={clip.key} asChild>
                    <button
                      type="button"
                      aria-label={translate("Scene {0}: {1} ({2} s, {3})", i + 1, clip.label || translate("without text"), spans[i].duration.toFixed(1), AUDIO_LABEL[clip.audio])}
                      title={`#${i + 1} · ${clip.label}`}
                      style={{ width: w }}
                      className={`clip group relative h-[60px] overflow-hidden rounded-[10px] bg-white/[0.06] text-left transition ${
                        active ? "clip-active" : "hover:brightness-110"
                      } ${clip.hasIssues ? "ring-2 ring-danger" : ""}`}
                    >
                      {tiles > 0 ? (
                        <span aria-hidden className="absolute inset-0 flex">
                          {Array.from({ length: tiles }, (_, t) => (
                            // eslint-disable-next-line @next/next/no-img-element -- remote stock thumbnails, not app assets
                            <img
                              key={t}
                              src={clip.thumbs[t % clip.thumbs.length]}
                              alt=""
                              loading="lazy"
                              draggable={false}
                              className="h-full flex-none object-cover"
                              style={{ width: TILE }}
                            />
                          ))}
                        </span>
                      ) : (
                        <span aria-hidden className="absolute inset-0 bg-gradient-to-br from-white/[0.10] to-white/[0.02]" />
                      )}
                      <span aria-hidden className="absolute inset-x-0 top-0 h-6 bg-gradient-to-b from-black/60 to-transparent" />
                      <span className="absolute left-1.5 top-1 flex max-w-[calc(100%-12px)] items-center gap-1 text-[10px] font-medium leading-4 text-white">
                        <span className="font-mono opacity-80">{i + 1}</span>
                        {w > 70 && <span className="truncate">{clip.label}</span>}
                      </span>
                      <span aria-hidden className={`absolute inset-x-0 bottom-0 h-[3px] ${AUDIO_BAR[clip.audio]}`} />
                    </button>
                    </ToggleGroup.Item>
                  </li>
                );
              })}
              <li className="ml-2 flex items-center">
                <Tooltip content={selected >= 0 ? translate("Add scene after selected") : translate("Add scene at the end")}>
                  <button
                    type="button"
                    onClick={onAdd}
                    disabled={!canAdd || readOnly}
                    aria-label={selected >= 0 ? translate("Add scene after selected") : translate("Add scene at the end")}
                    className="grid h-8 w-8 place-items-center rounded-lg bg-white text-black shadow transition hover:scale-105 disabled:opacity-30"
                  >
                    <PlusIcon />
                  </button>
                </Tooltip>
              </li>
            </ol>
            </ToggleGroup.Root>
          </div>

          {/* Playhead */}
          {total > 0 && (
            <div aria-hidden className="pointer-events-none absolute inset-y-0 z-10" style={{ left: 12 + Math.min(time, total) * pxPerSec }}>
              <span className="absolute -left-[5px] top-0 h-0 w-0 border-x-[5px] border-t-[7px] border-x-transparent border-t-white" />
              <span className="absolute -left-px top-0 h-full w-[2px] rounded bg-white shadow-[0_0_6px_rgba(255,255,255,0.6)]" />
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}

function formatMark(s: number): string {
  if (s < 60) return String(s).padStart(2, "0");
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function Chevron({ dir }: { dir: "left" | "right" }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={dir === "left" ? "M15 18l-6-6 6-6" : "M9 18l6-6-6-6"} />
    </svg>
  );
}

export function TrashIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 002 2h6a2 2 0 002-2l1-12M9 7V4h6v3" />
    </svg>
  );
}

export function PlusIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function ZoomIcon({ out = false }: { out?: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M20 20l-4.2-4.2M8 11h6" />
      {!out && <path d="M11 8v6" />}
    </svg>
  );
}

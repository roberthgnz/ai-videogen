"use client";

import { t as translate } from "@/lib/i18n";
import { useEffect, useMemo, useRef, useState } from "react";
import { FORMAT_SIZE, type VideoFormat } from "@/lib/domain";
import { assetUrl, type EditDocument, type EditClip, type EditAsset, type EditOverlay } from "@/lib/editing/schema";
import { clipFrame, frameStyle } from "@/lib/editing/motion";
import { overlayStyle } from "@/lib/editing/style";
import { DEFAULT_ACCENT, emphasisRuns } from "@/lib/editing/emphasis";
import { layeredClips } from "@/lib/editing/timeline";

/** A clip's media element is mounted this long before it starts, already seeked to its first frame, so a cut never waits on a decoder. */
const LOOKAHEAD = 1.5;
/** ...and kept this long after it ends, in case the playhead steps back a little. */
const LOOKBEHIND = 0.3;
/** While playing, a media element is only seeked back into place when it drifts more than this (s). */
const PLAYING_DRIFT = 0.25;
/** Never seek the same element more often than this (ms) while playing: seeking is what makes video stutter. */
const SEEK_INTERVAL = 500;

/** Whether a clip's element should exist at `time`: the clips under the playhead and the next ones, not all of them. */
export function clipNeedsElement(clip: EditClip, kind: EditAsset["kind"], time: number): boolean {
  if (kind === "image") return true;
  return time >= clip.start - LOOKAHEAD && time < clip.start + clip.duration + LOOKBEHIND;
}

function MediaClip({ clip, asset, time, playing, onError, onSelect }: { clip: EditClip; asset: EditAsset; time: number; playing: boolean; onError: (message: string) => void; onSelect: () => void }) {
  const ref = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  /** The pending play() promise: a pause() while it is unsettled is what rejects it with AbortError. */
  const pending = useRef<Promise<void> | null>(null);
  const lastSeek = useRef(0);
  const active = time >= clip.start && time < clip.start + clip.duration;
  const shouldPlay = active && playing;
  // Pre-roll (before the clip starts) rests on its first frame.
  const speed = clip.speed ?? 1;
  const target = clip.in + Math.max(0, Math.min(time, clip.start + clip.duration) - clip.start) * speed;
  const targetRef = useRef(target);
  useEffect(() => { targetRef.current = target; });

  const seek = (el: HTMLMediaElement, to: number) => {
    lastSeek.current = performance.now();
    el.currentTime = to;
  };

  // Play and pause only when the wanted state changes, never once per frame.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (shouldPlay) {
      if (!el.paused) return;
      if (Math.abs(el.currentTime - targetRef.current) > 0.05) seek(el, targetRef.current);
      const promise = el.play();
      pending.current = promise;
      promise
        .then(() => { if (pending.current === promise) pending.current = null; })
        .catch((e: Error) => {
          if (pending.current === promise) pending.current = null;
          // An interrupted play() (the playhead moved on, the clip was stopped) is not a failure.
          if (e.name !== "AbortError") onError(translate("Could not reproduce {0}: {1}", asset.name, e.message));
        });
      return;
    }
    const promise = pending.current;
    if (promise) promise.then(() => el.pause(), () => undefined);
    else if (!el.paused) el.pause();
  }, [shouldPlay, asset.name, onError]);

  // Keep the element on the playhead: exact frames when paused or scrubbing, loose and rare while playing.
  useEffect(() => {
    const el = ref.current;
    if (!el || el.readyState < 1) return;
    const drift = Math.abs(el.currentTime - target);
    if (!playing) {
      if (drift > 0.025) seek(el, target);
    } else if (shouldPlay && drift > PLAYING_DRIFT && performance.now() - lastSeek.current > SEEK_INTERVAL) {
      seek(el, target);
    } else if (!shouldPlay && !active && drift > 0.05) {
      // Waiting for its turn: sit on the first frame.
      seek(el, target);
    }
  }, [time, playing, shouldPlay, active, target]);

  useEffect(() => { if (ref.current) ref.current.volume = clip.volume; }, [clip.volume]);
  // Constant speed; the browser keeps the pitch of the voice.
  useEffect(() => { if (ref.current) ref.current.playbackRate = speed; }, [speed]);

  // A freshly mounted element goes to its place as soon as it can.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ready = () => { el.volume = clip.volume; el.playbackRate = speed; if (Math.abs(el.currentTime - targetRef.current) > 0.025) seek(el, targetRef.current); };
    if (el.readyState >= 1) ready();
    el.addEventListener("loadedmetadata", ready);
    return () => el.removeEventListener("loadedmetadata", ready);
  }, [clip.volume, speed]);

  const style: React.CSSProperties = { position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: clip.fit, display: active ? "block" : "none", ...(asset.kind !== "audio" && (clip.transition !== "cut" || clip.motion !== "none") ? frameStyle(clipFrame(clip, time)) : null) };
  if (asset.kind === "image") {
    // eslint-disable-next-line @next/next/no-img-element -- local user media with an intrinsic video canvas
    return <img src={assetUrl(asset)} alt={asset.name} style={style} draggable={false} onClick={onSelect} />;
  }
  return asset.kind === "audio"
    ? <audio ref={ref} src={assetUrl(asset)} preload="auto" onError={() => onError(translate("It could not be loaded {0}.", asset.name))} />
    : <video ref={ref} src={assetUrl(asset)} preload="auto" playsInline style={style} onClick={onSelect} onError={() => onError(translate("It could not be loaded {0}.", asset.name))} />;
}

export function EditCanvas({ doc, format, time, playing, selected, disabled, guides = false, zoom = null, onSelect, onChange, onDragStart, onDragEnd, onError }: {
  doc: EditDocument; format: VideoFormat; time: number; playing: boolean; selected: string | null; disabled: boolean;
  guides?: boolean;
  zoom?: number | null;
  onDragEnd: () => void;
  onSelect: (id: string | null) => void; onChange: (id: string, patch: Partial<EditOverlay>) => void; onDragStart: () => void; onError: (message: string) => void;
}) {
  const wrapper = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const drag = useRef<{ id: string; px: number; py: number; x: number; y: number; width: number; height: number; maxY: number; started: boolean } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const editingRef = useRef<HTMLDivElement>(null);
  const cancelEdit = useRef(false);
  const [snapX, setSnapX] = useState(false);
  const [snapY, setSnapY] = useState(false);
  const output = FORMAT_SIZE[format];
  // A clip on a higher video track covers the ones below, as on the timeline.
  const layered = useMemo(() => layeredClips(doc), [doc]);
  const scale = zoom ?? Math.max(0, Math.min(size.width / output.width, size.height / output.height));
  useEffect(() => {
    if (!editing || !editingRef.current) return;
    const el = editingRef.current;
    el.focus({ preventScroll: true });
    const range = document.createRange(); range.selectNodeContents(el);
    const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
  }, [editing]);
  function finishDrag() {
    if (drag.current?.started) onDragEnd();
    drag.current = null; setSnapX(false); setSnapY(false);
  }
  useEffect(() => {
    const el = wrapper.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return <div ref={wrapper} tabIndex={0} className={`editor-canvas-area relative flex min-h-[140px] flex-1 items-center justify-center overflow-auto p-4 outline-none ${zoom !== null ? 'is-zoomed' : ''}`} aria-label={translate("Editable canvas")} onPointerDown={(e) => e.currentTarget.focus({ preventScroll: true })}>
    <div className="editor-canvas-frame relative flex-none overflow-hidden" style={{ width: output.width * scale, height: output.height * scale, margin: zoom !== null ? 'auto' : undefined }}>
      <div ref={frame} style={{ position: "relative", width: output.width, height: output.height, transform: `scale(${scale})`, transformOrigin: "top left", background: doc.background }}
        onPointerDown={(e) => { if (e.target === e.currentTarget) onSelect(null); }}>
        {layered.map((clip) => {
          const asset = doc.assets.find((a) => a.id === clip.assetId);
          return asset && clipNeedsElement(clip, asset.kind, time) ? <MediaClip key={clip.id} clip={clip} asset={asset} time={time} playing={playing} onError={onError} onSelect={() => onSelect(clip.id)} /> : null;
        })}
        {guides && <div aria-hidden className="pointer-events-none absolute inset-[10%] z-20 border border-dashed border-white/40"><div className="absolute left-1/2 top-0 h-full border-l border-dashed border-white/15" /><div className="absolute left-0 top-1/2 w-full border-t border-dashed border-white/15" /></div>}
        {doc.overlays.filter((o) => time >= o.start && time < o.start + o.duration).sort((a, b) => Number(a.kind === "caption") - Number(b.kind === "caption")).map((o) => <div key={o.id}
          role={editing === o.id ? "textbox" : "button"} tabIndex={0} data-editor-overlay aria-label={`${editing === o.id ? translate("Edit") : translate("Move")} ${o.kind === "caption" ? translate("subtitle") : "texto"}: ${o.text}`}
          ref={editing === o.id ? editingRef : undefined} contentEditable={editing === o.id} suppressContentEditableWarning
          style={{ ...overlayStyle(o), outline: selected === o.id ? `${1.5 / Math.max(scale, 0.1)}px solid #4c8dff` : undefined, cursor: disabled ? "default" : editing === o.id ? 'text' : "move", touchAction: editing === o.id ? 'auto' : "none" }}
          onFocus={() => onSelect(o.id)}
          onDoubleClick={(e) => { if (!disabled) { e.stopPropagation(); cancelEdit.current = false; setEditing(o.id); onDragStart(); } }}
          onBlur={(e) => {
            if (editing !== o.id) return;
            const text = e.currentTarget.innerText.trim().slice(0, 1000);
            if (!cancelEdit.current && text && text !== o.text) onChange(o.id, { text });
            e.currentTarget.textContent = !cancelEdit.current && text ? text : o.text;
            cancelEdit.current = false; setEditing(null); onDragEnd();
          }}
          onKeyDown={(e) => {
            if (editing === o.id) {
              if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelEdit.current = true; e.currentTarget.blur(); }
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); e.currentTarget.blur(); }
              return;
            }
            if (disabled || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
            e.preventDefault(); onDragStart();
            const step = e.shiftKey ? 2 : 0.25;
            onChange(o.id, { x: Math.max(0, Math.min(100 - o.width, o.x + (e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0))),
              y: Math.max(0, Math.min(95, o.y + (e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0))) });
            onDragEnd();
          }}
          onPointerDown={(e) => {
            if (disabled) return;
            if (editing === o.id) { e.stopPropagation(); return; }
            e.preventDefault(); e.stopPropagation(); e.currentTarget.focus({ preventScroll: true }); onSelect(o.id);
            e.currentTarget.setPointerCapture(e.pointerId);
            const bounds = frame.current!.getBoundingClientRect();
            drag.current = { id: o.id, px: e.clientX, py: e.clientY, x: o.x, y: o.y, width: bounds.width, height: bounds.height, maxY: Math.max(0, 100 - e.currentTarget.getBoundingClientRect().height / bounds.height * 100), started: false };
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (!d || d.id !== o.id) return;
            if (!d.started && Math.hypot(e.clientX - d.px, e.clientY - d.py) < 3) return;
            if (!d.started) { d.started = true; onDragStart(); }
            let dx = e.clientX - d.px, dy = e.clientY - d.py;
            if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
            let x = Math.max(0, Math.min(100 - o.width, d.x + dx / d.width * 100));
            let y = Math.max(0, Math.min(d.maxY, d.y + dy / d.height * 100));
            const sx = !e.altKey && Math.abs(x + o.width / 2 - 50) < 1;
            const sy = !e.altKey && Math.abs(y + (100 - d.maxY) / 2 - 50) < 1;
            if (sx) x = 50 - o.width / 2;
            if (sy) y = 50 - (100 - d.maxY) / 2;
            setSnapX(sx); setSnapY(sy); onChange(o.id, { x, y });
          }} onPointerUp={finishDrag} onPointerCancel={finishDrag} onLostPointerCapture={finishDrag}>
          {editing === o.id || !o.emphasis?.length ? o.text : emphasisRuns(o).map((r, i) => r.on ? <span key={i} style={{ color: o.accent ?? DEFAULT_ACCENT }}>{r.text}</span> : r.text)}
        </div>)}
        {snapX && <div aria-hidden style={{ position: 'absolute', zIndex: 50, left: '50%', top: 0, height: '100%', borderLeft: `${1 / Math.max(scale, .1)}px solid #4c8dff`, pointerEvents: 'none' }} />}
        {snapY && <div aria-hidden style={{ position: 'absolute', zIndex: 50, top: '50%', left: 0, width: '100%', borderTop: `${1 / Math.max(scale, .1)}px solid #4c8dff`, pointerEvents: 'none' }} />}
      </div>
    </div>
  </div>;
}

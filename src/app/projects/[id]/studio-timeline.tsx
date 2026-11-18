"use client";

import { t as translate, localizedLabels } from "@/lib/i18n";
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { musicClipDefaults } from "@/lib/editing/music";
import { editDuration, type EditDocument } from "@/lib/editing/schema";
import { ASSET_TYPE, assetKindType, assetSeconds, frameTime, freeStart, mainInsertion, moveItem, placedItems, removeItems, shortTime, snapSpan, thumbnailUrl, timelineLanes, trimItem, withTracks, type TimelineItem, type TimelineKind, type TimelineLane } from "@/lib/editing/timeline";
import { EditorIcon, ToolButton } from "./desktop-controls";

const names = localizedLabels((translate) => ({ video: translate("Video"), audio: "Audio", text: translate("Text"), caption: translate("Subtitles") }));
const icons = { video: "media", audio: "music", text: "text", caption: "captions" } as const;
const KIND_ORDER: TimelineKind[] = ["video", "audio", "text", "caption"];
const END_GUTTER = 16;
/** Width of the column of lane icons, left of the tracks (matches --lane-label in studio.css). */
const LABEL = 44;
/** Height of the ruler (matches .pro-ruler in studio.css). */
const RULER = 26;
export const LANE_HEIGHT: Record<TimelineKind, number> = { video: 64, audio: 48, text: 40, caption: 40 };
/** A clip sits this far inside its lane, below the lane's 1 px top border. */
const INSET = 4;
/** Edges this close (px) snap together. */
const SNAP_PX = 8;
/** Dragging this close (px) to the edge of the timeline scrolls it. */
const EDGE_PX = 40;
/** Pointer travel (px) before a press on a clip becomes a drag. */
const DRAG_PX = 4;
/** A dragged clip stays on its track until its centre is this far (px) past the track's edge. */
const STICK_PX = 6;
/** How long (ms) a released clip slides into its place (a little over .is-settling in studio.css). */
const SETTLE_MS = 200;
const laneKey = (kind: TimelineKind, track: number) => `${kind}:${track}`;
const exactTime = (n: number) => `${Math.floor(n / 60)}:${(n % 60).toFixed(2).padStart(5, "0")}`;

type Mode = "move" | "in" | "out";
/** A row as drawn. `fresh` is a track that does not exist yet: the one a drag can put its clip on. */
type Row = TimelineLane & { fresh?: boolean };
type Target = { kind: TimelineKind; track: number };
/** Where a dragged library file would go: the clip starts at `time` and lasts `duration` (0 when unknown); `at` is the pointer time. */
type Drop = Target & { time: number; at: number; duration: number };
interface Live {
  doc: EditDocument; rows: Row[]; id: string; mode: Mode; guide: number | null; target: Target | null;
  /** Where the moved clip is drawn (it follows the pointer); `doc` says where it will land. */
  float: number | null;
  push: boolean;
  /** Pixels per second at the press: the timeline keeps it until the drag ends, whatever happens to its width. */
  scale: number;
}
interface Drag {
  id: string; mode: Mode; item: TimelineItem; base: EditDocument;
  /** The rows on screen: as they were at the press, so nothing jumps under the pointer, plus the new track once the drag asks for it. */
  rows: Row[];
  /** The track the clip is over, and whether dragging it past the last one opens a new one. */
  track: number; canOpen: boolean;
  /**
   * Edges to snap to. Until the dragged edge has `left` where it was, on its own track it uses `loose`:
   * the ones not at that very place, so a small move is a small move and not a snap back.
   */
  anchors: number[]; loose: number[]; left: boolean;
  /** Pointer time minus the dragged edge's time, and pointer height minus the middle of the clip's row, at the press. */
  offset: number; grabY: number;
  scale: number; magnetic: boolean; snap: boolean;
  /** A trim on the magnetic main track (what follows moves along), and where it leaves the playhead when it ends. */
  ripple: boolean; park: number | null;
  x0: number; y0: number; x: number; y: number; alt: boolean; push: boolean; started: boolean; result: EditDocument | null; frame: number;
  finish: (commit: boolean) => void;
}

function layoutOf(rows: Row[]) {
  const map = new Map<string, { top: number; height: number }>();
  let top = 0;
  for (const row of rows) { map.set(laneKey(row.kind, row.track), { top, height: LANE_HEIGHT[row.kind] }); top += LANE_HEIGHT[row.kind]; }
  return { map, height: top };
}

/** `rows` plus a new, empty track of `kind` where that kind grows: above the video tracks, below the tracks of any other kind. */
function withFresh(rows: Row[], kind: TimelineKind): Row[] {
  const own = rows.filter((r) => r.kind === kind);
  if (own.some((r) => r.fresh)) return rows;
  let index = rows.length;
  if (own.length) index = kind === "video" ? rows.indexOf(own[0]) : rows.indexOf(own.at(-1)!) + 1;
  else {
    const next = rows.findIndex((r) => KIND_ORDER.indexOf(r.kind) > KIND_ORDER.indexOf(kind));
    if (next >= 0) index = next;
  }
  return [...rows.slice(0, index), { kind, track: own.length, items: [], fresh: true }, ...rows.slice(index)];
}

/**
 * The track of `kind` at height `y` (px below the top of the tracks): the one there, or the nearest.
 * It stays on `held` until `y` is clearly past that track's edge. Past the last track on the side the
 * kind grows, `open` asks for a new one, unless `rows` has it already or `canOpen` says no.
 */
function hitTrack(kind: TimelineKind, y: number, rows: Row[], held: number | null, canOpen: boolean): { track: number; open: boolean } {
  const own = rows.filter((r) => r.kind === kind);
  if (!own.length) return { track: 0, open: true };
  const { map } = layoutOf(rows);
  const bands = own.map((r) => map.get(laneKey(r.kind, r.track))!);
  const stay = own.findIndex((r) => r.track === held);
  if (stay >= 0 && y >= bands[stay].top - STICK_PX && y < bands[stay].top + bands[stay].height + STICK_PX) return { track: own[stay].track, open: false };
  const past = kind === "video" ? y < bands[0].top : y >= bands.at(-1)!.top + bands.at(-1)!.height;
  if (past && canOpen && !own.some((r) => r.fresh)) return { track: own.length, open: true };
  const at = bands.findIndex((b) => y < b.top + b.height);
  return { track: own[at < 0 ? own.length - 1 : at].track, open: false };
}

interface Props {
  projectId: string; doc: EditDocument; time: number; selected: string | null; disabled: boolean;
  playing?: boolean;
  /** Main video track packs its clips back to back (and closes gaps). */
  magnetic: boolean; onMagnetic: (on: boolean) => void;
  onSelect: (id: string) => void; onSeek: (time: number) => void;
  /** A drag or a keyboard edit starts (stop playback). */
  onBegin: () => void;
  /** What the montage would be if the drag ended now, for the canvas; null when it ends. */
  onPreview: (doc: EditDocument | null) => void;
  /** A finished edit; `group` merges a burst of key presses into one undo step. */
  onCommit: (doc: EditDocument, group?: string) => void;
  /** A library file dropped to start at `time`, on that lane when it is one of its kind (`at` is the pointer time). */
  onAdd: (assetId: string, time: number, lane: { kind: TimelineKind; track: number; at: number } | null) => void;
  onImport: () => void;
  onSplit: () => void; canSplit: boolean;
  onUndo: () => void; onRedo: () => void; canUndo: boolean; canRedo: boolean;
}

export function StudioTimeline({ projectId, doc, time, selected, disabled, playing = false, magnetic, onMagnetic, onSelect, onSeek, onBegin, onPreview, onCommit, onAdd, onImport, onSplit, canSplit, onUndo, onRedo, canUndo, canRedo }: Props) {
  const viewport = useRef<HTMLDivElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  const tracks = useRef<HTMLDivElement>(null);
  const scrubbing = useRef(false);
  const [viewportWidth, setViewportWidth] = useState(800);
  const [zoom, setZoom] = useState(1);
  const [snap, setSnap] = useState(true);
  const [height, setHeight] = useState(248);
  const [drop, setDrop] = useState<Drop | null>(null);
  const [live, setLive] = useState<Live | null>(null);
  /** The clip just released: it slides from where it was held to where it landed. */
  const [settling, setSettling] = useState<string | null>(null);
  const drag = useRef<Drag | null>(null);
  const settle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Window listeners of a drag outlive the render that started it: they reach the parent through here.
  const latest = useRef({ onBegin, onPreview, onCommit, onSeek });
  useLayoutEffect(() => { latest.current = { onBegin, onPreview, onCommit, onSeek }; });

  const lanes = useMemo(() => timelineLanes(doc), [doc]);
  // A drag keeps its own rows; a library file over the timeline is offered a new track of its kind.
  const liveRows = live?.rows, dropKind = drop?.kind;
  const rows = useMemo<Row[]>(() => liveRows ?? (dropKind ? withFresh(lanes, dropKind) : lanes), [liveRows, dropKind, lanes]);
  const items = useMemo(() => {
    const shown = live ? live.doc : doc;
    const byId = new Map((live ? placedItems(live.doc) : lanes.flatMap((l) => l.items)).map((i) => [i.id, i]));
    // A trim never changes tracks, even while its edge is drawn over a neighbour.
    if (live && live.mode !== "move") for (const was of lanes.flatMap((l) => l.items)) {
      const now = byId.get(was.id);
      if (now && now.track !== was.track) byId.set(was.id, { ...now, track: was.track });
    }
    // Always in the document's order: the DOM never reshuffles, so a dragged or focused clip keeps its element.
    return [...shown.clips, ...shown.overlays].flatMap((x) => byId.get(x.id) ?? []);
  }, [live, doc, lanes]);
  const total = editDuration(doc);
  // The scale follows the saved montage, not the drag: what is under the pointer never rescales mid-gesture.
  const width = Math.max(360, viewportWidth - LABEL - END_GUTTER) * zoom;
  const scale = live?.scale ?? width / Math.max(1, total);
  // A file over the magnetic main track: the clips from that cut on move over to make room for it.
  const room = drop && !live && magnetic && drop.kind === "video" && drop.track === 0 && drop.duration > 0 ? drop : null;
  const shownEnd = Math.max(0, ...items.map((i) => i.start + i.duration), drop ? drop.time + drop.duration : 0) + (room ? room.duration : 0);
  const contentWidth = live || drop ? Math.max(width, shownEnd * scale + 120) : width;
  const markStep = [0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600].find((step) => step * scale >= 70) ?? 1200;
  const marks = Array.from({ length: Math.min(400, Math.floor(contentWidth / scale / markStep) + 1) }, (_, i) => i * markStep);

  const layout = useMemo(() => layoutOf(rows), [rows]);
  function box(at: Target): { top: number; height: number } {
    const row = layout.map.get(laneKey(at.kind, at.track)) ?? { top: 0, height: LANE_HEIGHT[at.kind] };
    return { top: row.top + 1 + INSET, height: row.height - 1 - 2 * INSET };
  }

  useEffect(() => {
    if (!viewport.current) return;
    const observer = new ResizeObserver(([entry]) => setViewportWidth(entry.contentRect.width));
    observer.observe(viewport.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const el = viewport.current;
    if (!el || live || drag.current || scrubbing.current) return;
    const playhead = LABEL + time * scale;
    const left = el.scrollLeft;
    const width = el.clientWidth;
    if (width <= 0) return;
    if (playing) {
      if (playhead > left + width - 20) {
        el.scrollLeft = playhead - 40;
      } else if (playhead < left) {
        el.scrollLeft = Math.max(0, playhead - 40);
      }
    } else {
      if (playhead < left || playhead > left + width - 40) {
        el.scrollTo({ left: Math.max(0, playhead - width / 2), behavior: "smooth" });
      }
    }
  }, [time, scale, live, playing]);
  useEffect(() => {
    // A library file dragged away, or let go anywhere else, leaves nothing behind here.
    const clear = () => setDrop(null);
    window.addEventListener("dragend", clear);
    return () => { window.removeEventListener("dragend", clear); drag.current?.finish(false); clearTimeout(settle.current); };
  }, []);

  function pointerTime(clientX: number) { return Math.max(0, Math.min(total, (clientX - grid.current!.getBoundingClientRect().left) / scale)); }
  /** Whether dragging `item` past its kind's last track opens a new one: not when it is alone on that last track already. */
  function opens(item: TimelineItem) {
    const own = lanes.filter((l) => l.kind === item.kind);
    const edge = item.kind === "video" ? own[0] : own.at(-1);
    return !(edge && edge.items.length === 1 && edge.items[0].id === item.id);
  }

  function step(d: Drag) {
    if (!d.started) {
      if (Math.hypot(d.x - d.x0, d.y - d.y0) < DRAG_PX) return;
      d.started = true;
      latest.current.onBegin();
    }
    const pointer = (d.x - grid.current!.getBoundingClientRect().left) / d.scale;
    const tolerance = SNAP_PX / d.scale, snapping = d.snap && !d.alt;
    let result: EditDocument, shown: EditDocument | undefined, guide: number | null = null, target: Target | null = null, float: number | null = null, push = false;
    if (d.mode === "move") {
      const kind = d.item.kind;
      // The clip is held where it was grabbed: its middle decides the track, so it changes halfway into the next one.
      const hit = hitTrack(kind, d.y - (tracks.current?.getBoundingClientRect().top ?? 0) - d.grabY, d.rows, d.track, d.canOpen);
      if (hit.open) d.rows = withFresh(d.rows, kind);
      d.track = hit.track;
      target = { kind, track: hit.track };
      // On the magnetic main track the order decides where it goes, not the exact time.
      const ordered = d.magnetic && kind === "video" && hit.track === 0;
      const held = Math.max(0, pointer - d.offset);
      if (Math.abs(held - d.item.start) > tolerance) d.left = true;
      push = d.push && !ordered;
      const put = (start: number) => moveItem(d.base, d.id, { start, track: hit.track, at: held, push }, d.magnetic);
      float = frameTime(held);
      result = put(float);
      if (!ordered && snapping) {
        // On another track it snaps to the time it had from the first moment: changing track alone keeps it.
        const snapped = snapSpan(held, d.item.duration, hit.track === d.item.track && !d.left ? d.loose : d.anchors, tolerance);
        const start = Math.max(0, snapped.start);
        const there = snapped.guide === null ? null : put(start);
        const landed = there && (there.clips.find((c) => c.id === d.id) ?? there.overlays.find((o) => o.id === d.id));
        // Only an edge the clip can land on pulls it: over a taken place it keeps following the pointer.
        if (there && landed && Math.abs(landed.start - start) < 0.002) { result = there; float = start; guide = snapped.guide; }
      }
    } else {
      const edge = d.mode === "in" ? d.item.start : d.item.start + d.item.duration;
      let at = pointer - d.offset;
      if (Math.abs(at - edge) > tolerance) d.left = true;
      if (snapping) ({ start: at, guide } = snapSpan(at, 0, d.left ? d.anchors : d.loose, tolerance));
      else at = frameTime(at);
      result = trimItem(d.base, d.id, d.mode, at - edge, d.magnetic);
      const packed = d.ripple && d.mode === "in" ? result.clips.find((c) => c.id === d.id) : undefined;
      if (packed) {
        // The start of a clip on the magnetic track ends where it was (the track closes up). While it is
        // held, it is the edge that follows the pointer and the rest that waits, as on any other track.
        const start = Math.round((d.item.start + d.item.duration - packed.duration) * 1000) / 1000;
        if (start >= 0) shown = { ...d.base, clips: d.base.clips.map((c) => c.id === d.id ? { ...packed, start } : c) };
        d.park = packed.start;
      }
      // The playhead rides the edge being trimmed, so the canvas shows the frame the cut lands on.
      const drawn = shown ?? result;
      const trimmed = drawn.clips.find((c) => c.id === d.id) ?? drawn.overlays.find((o) => o.id === d.id);
      if (trimmed) latest.current.onSeek(d.mode === "in" ? trimmed.start : Math.max(trimmed.start, trimmed.start + trimmed.duration - 1 / 30));
    }
    d.result = result;
    // What is drawn (and played on the canvas) while the drag lasts; `result` is what it leaves.
    shown ??= result;
    setLive({ doc: shown, rows: d.rows, id: d.id, mode: d.mode, guide, target, float, push, scale: d.scale });
    latest.current.onPreview(shown);
  }

  function tick(d: Drag) {
    d.frame = 0;
    if (drag.current !== d) return;
    step(d);
    const el = viewport.current;
    if (!d.started || !el) return;
    const r = el.getBoundingClientRect();
    const speed = (gap: number) => Math.ceil(Math.min(1, (EDGE_PX - gap) / EDGE_PX) * 18);
    const dx = d.x < r.left + LABEL + EDGE_PX ? -speed(d.x - r.left - LABEL) : d.x > r.right - EDGE_PX ? speed(r.right - d.x) : 0;
    const dy = d.mode !== "move" ? 0 : d.y < r.top + RULER ? -8 : d.y > r.bottom - 12 ? 8 : 0;
    const canX = dx < 0 ? el.scrollLeft > 0 : dx > 0 && el.scrollLeft < el.scrollWidth - el.clientWidth - 1;
    const canY = dy < 0 ? el.scrollTop > 0 : dy > 0 && el.scrollTop < el.scrollHeight - el.clientHeight - 1;
    if (canX) el.scrollLeft += dx;
    if (canY) el.scrollTop += dy;
    // Keep scrolling while the pointer rests at the edge: no pointer event comes then.
    if (canX || canY) d.frame = requestAnimationFrame(() => tick(d));
  }

  function begin(e: React.PointerEvent<HTMLButtonElement>, item: TimelineItem, mode: Mode) {
    if (disabled || e.button !== 0 || drag.current) return;
    e.preventDefault(); e.stopPropagation();
    e.currentTarget.focus({ preventScroll: true });
    onSelect(item.id);
    // A click brings the playhead to a clip it is not over; a drag leaves it alone, so a clip can be dragged onto it.
    const seek = mode === "move" && (time < item.start || time >= item.start + item.duration) ? item.start : null;
    const grab = (e.clientX - grid.current!.getBoundingClientRect().left) / scale;
    const row = layoutOf(lanes).map.get(laneKey(item.kind, item.track));
    const base = withTracks(doc);
    const onMain = (i: TimelineItem) => i.kind === "video" && i.track === 0;
    const ripple = mode !== "move" && magnetic && onMain(item);
    // Edges to snap to, where they are while the drag lasts: without the moved clip the magnetic main track closes its gap, and a trim there carries along what follows.
    const still = placedItems(mode === "move" ? removeItems(base, [item.id], magnetic) : base).filter((i) => i.id !== item.id && !(ripple && onMain(i) && i.start >= item.start));
    const edges = [0, time, ...still.flatMap((i) => [i.start, i.start + i.duration])];
    const origin = mode === "move" ? [item.start, item.start + item.duration] : [mode === "in" ? item.start : item.start + item.duration];
    const pointerId = e.pointerId;
    const d: Drag = {
      id: item.id, mode, item, base, rows: lanes, track: item.track, canOpen: opens(item),
      anchors: [...edges, ...origin], loose: edges.filter((a) => origin.every((o) => Math.abs(a - o) > 1 / 60)), left: false,
      offset: grab - (mode === "out" ? item.start + item.duration : item.start),
      grabY: row ? e.clientY - (tracks.current?.getBoundingClientRect().top ?? 0) - row.top - row.height / 2 : 0,
      scale, magnetic, snap, ripple, park: null,
      x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, alt: e.altKey, push: e.ctrlKey || e.metaKey, started: false, result: null, frame: 0, finish: () => {},
    };
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      d.x = ev.clientX; d.y = ev.clientY; d.alt = ev.altKey; d.push = ev.ctrlKey || ev.metaKey;
      if (!d.frame) d.frame = requestAnimationFrame(() => tick(d));
    };
    const up = (ev: PointerEvent) => { if (ev.pointerId === pointerId) d.finish(true); };
    const cancel = (ev: PointerEvent) => { if (ev.pointerId === pointerId) d.finish(false); };
    const key = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") { if (ev.type === "keydown") { ev.preventDefault(); ev.stopPropagation(); d.finish(false); } return; }
      // Alt (no snapping) and Ctrl / ⌘ (push what follows) count from the moment they are pressed or let go.
      if (ev.key !== "Alt" && ev.key !== "Control" && ev.key !== "Meta") return;
      d.alt = ev.altKey; d.push = ev.ctrlKey || ev.metaKey;
      if (!d.started) return;
      if (ev.key === "Alt") ev.preventDefault();
      step(d);
    };
    const blur = () => d.finish(false);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", key, true);
    window.addEventListener("keyup", key, true);
    window.addEventListener("blur", blur);
    d.finish = (commit) => {
      if (drag.current !== d) return;
      // The last position may still be waiting for its frame.
      if (commit) step(d);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("keyup", key, true);
      window.removeEventListener("blur", blur);
      cancelAnimationFrame(d.frame);
      drag.current = null;
      if (d.started) {
        // A clip let go where it was changes nothing: no undo step, nothing to save.
        const next = commit && d.result ? withTracks(d.result) : null;
        if (next && JSON.stringify(next) !== JSON.stringify(d.base)) latest.current.onCommit(next);
        latest.current.onPreview(null);
        if (d.mode === "move") {
          clearTimeout(settle.current);
          setSettling(d.id);
          settle.current = setTimeout(() => setSettling(null), SETTLE_MS);
        }
        // A trim takes the playhead along with its edge: called off, the playhead goes back as well.
        else if (!commit) latest.current.onSeek(time);
        else if (d.park !== null) latest.current.onSeek(d.park);
      } else if (commit && seek !== null) latest.current.onSeek(seek);
      setLive(null);
    };
    drag.current = d;
  }

  function keyboard(e: React.KeyboardEvent, item: TimelineItem, mode: Mode) {
    if (disabled || drag.current) return;
    const horizontal = e.key === "ArrowLeft" || e.key === "ArrowRight";
    const vertical = mode === "move" && (e.key === "ArrowUp" || e.key === "ArrowDown");
    if (!horizontal && !vertical) return;
    e.preventDefault(); e.stopPropagation();
    const base = withTracks(doc);
    const sign = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : -1;
    const frames = (e.shiftKey ? 10 : 1) / 30;
    let next: EditDocument;
    if (vertical) {
      // On screen, video tracks stack upwards (the top one covers the rest) and the others downwards.
      const track = item.track + (item.kind === "video" ? -sign : sign);
      const count = lanes.filter((l) => l.kind === item.kind).length;
      if (track < 0 || track > count || (track === count && !opens(item))) return;
      next = moveItem(base, item.id, { start: item.start, track, at: item.start }, magnetic);
    } else if (mode !== "move") {
      next = trimItem(base, item.id, mode, sign * frames, magnetic);
    } else if (magnetic && item.kind === "video" && item.track === 0) {
      // A packed track has no free time to nudge into: the arrows swap the clip with its neighbour.
      const lane = lanes.find((l) => l.kind === "video" && l.track === 0)?.items ?? [];
      const other = lane[lane.findIndex((i) => i.id === item.id) + sign];
      if (!other) return;
      next = moveItem(base, item.id, { start: item.start, track: 0, at: sign < 0 ? other.start : other.start + other.duration }, true);
    } else {
      next = moveItem(base, item.id, { start: item.start + sign * frames, track: item.track, at: item.start }, magnetic);
    }
    onBegin();
    onCommit(withTracks(next), `key:${item.id}:${mode}`);
  }

  function dragOver(e: React.DragEvent) {
    if (disabled || !e.dataTransfer.types.includes(ASSET_TYPE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    // An empty timeline takes the file as its first clip, wherever it is dropped.
    if (!lanes.length || !tracks.current) return;
    const kind: TimelineKind = e.dataTransfer.types.includes(assetKindType("audio")) ? "audio" : "video";
    // A new track of its kind is on offer for as long as the file is over the timeline.
    const hit = hitTrack(kind, e.clientY - tracks.current.getBoundingClientRect().top, withFresh(lanes, kind), drop?.kind === kind ? drop.track : null, false);
    const at = Math.max(0, (e.clientX - grid.current!.getBoundingClientRect().left) / scale);
    const seconds = assetSeconds(e.dataTransfer.types);
    let place: number, duration = 0;
    if (magnetic && kind === "video" && hit.track === 0) { place = mainInsertion(doc, at).time; duration = seconds; }
    else {
      const edges = lanes.flatMap((l) => l.items).flatMap((i) => [i.start, i.start + i.duration]);
      const wanted = Math.max(0, snap && !e.altKey ? snapSpan(at, kind === "audio" ? 0 : seconds, [0, time, ...edges], SNAP_PX / scale).start : frameTime(at));
      duration = kind === "audio" && seconds ? musicClipDefaults(doc, { duration: seconds }, wanted).duration : seconds;
      // It never lands on another clip: it takes the free place nearest to the pointer on that track.
      place = (duration ? freeStart(lanes.find((l) => l.kind === kind && l.track === hit.track)?.items ?? [], wanted, duration) : null) ?? wanted;
    }
    setDrop((was) => was && was.kind === kind && was.track === hit.track && was.time === place && was.at === at && was.duration === duration ? was : { kind, track: hit.track, time: place, at, duration });
  }
  function dropAsset(e: React.DragEvent) {
    e.preventDefault();
    const id = e.dataTransfer.getData(ASSET_TYPE);
    const to = drop;
    setDrop(null);
    if (!id || disabled) return;
    if (to) onAdd(id, to.time, { kind: to.kind, track: to.track, at: to.at });
    else onAdd(id, lanes.length ? pointerTime(e.clientX) : 0, null);
  }
  /** The pointer left the timeline (not just one of its children for another). */
  function dragLeave(e: React.DragEvent) {
    const r = viewport.current?.getBoundingClientRect();
    if (!r || e.clientX <= r.left || e.clientX >= r.right || e.clientY <= r.top || e.clientY >= r.bottom) setDrop(null);
  }

  const scrub = {
    onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => { if (e.button === 0) { scrubbing.current = true; e.currentTarget.setPointerCapture(e.pointerId); onSeek(pointerTime(e.clientX)); } },
    onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => { if (e.currentTarget.hasPointerCapture(e.pointerId)) onSeek(pointerTime(e.clientX)); },
    onPointerUp: () => { scrubbing.current = false; },
    onPointerCancel: () => { scrubbing.current = false; },
  };
  const laneName = (lane: Row) => {
    if (lane.fresh) return translate("New track of {0}", names[lane.kind].toLowerCase());
    const count = rows.filter((r) => r.kind === lane.kind && !r.fresh).length;
    if (lane.kind === "video" && lane.track === 0 && magnetic) return count > 1 ? translate("Main video (magnetic)") : translate("Video (magnetic)");
    return `${names[lane.kind]}${count > 1 ? ` ${lane.track + 1}` : ""}`;
  };
  const aim = live ? live.mode === "move" ? live.target : null : drop;
  const isTarget = (lane: Row) => !!aim && aim.kind === lane.kind && aim.track === lane.track;
  const onFresh = rows.some((r) => r.fresh && isTarget(r));
  // The place a dropped file would take; a line at the pointer when its length is not known.
  const dropBox = drop && !live && drop.duration > 0 ? box(drop) : null;

  return <section className={`pro-timeline${live ? live.mode === "move" ? " is-dragging" : " is-trimming" : drop ? " is-dropping" : ""}`} aria-label={translate("Timeline")} style={{ height }}>
    <div role="separator" tabIndex={0} aria-label={translate("Timeline height")} aria-orientation="horizontal" aria-valuenow={height} aria-valuemin={130} aria-valuemax={360} className="pro-timeline-resize"
      onKeyDown={(e) => { if (e.key === "ArrowUp" || e.key === "ArrowDown") { e.preventDefault(); e.stopPropagation(); setHeight((h) => Math.max(130, Math.min(360, h + (e.key === "ArrowUp" ? 20 : -20)))); } }}
      onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); e.currentTarget.dataset.origin = `${e.clientY},${height}`; }}
      onPointerMove={(e) => { if (e.currentTarget.hasPointerCapture(e.pointerId)) { const [y, initial] = e.currentTarget.dataset.origin!.split(",").map(Number); setHeight(Math.max(130, Math.min(360, initial + y - e.clientY))); } }}><span /></div>
    <div className="pro-timeline-toolbar"><div><ToolButton icon="undo" label={translate("Undo")} shortcut="Ctrl / ⌘ Z" disabled={!canUndo} onClick={onUndo} /><ToolButton icon="redo" label={translate("Redo")} shortcut="Ctrl / ⌘ ⇧ Z" disabled={!canRedo} onClick={onRedo} /><span className="editor-divider" /><ToolButton icon="split" label={translate("Divide in cursor")} shortcut="Ctrl / ⌘ B" disabled={!canSplit || disabled} onClick={onSplit} /><ToolButton icon="magnet" label={translate("Adjust to cuts and cursor (Alt when dragging it off; Ctrl / ∞ when dragging it pushes what follows)")} aria-pressed={snap} onClick={() => setSnap(!snap)} /><ToolButton icon="ripple" label={translate("Magnetic main track: the main video track clips are followed, with no gaps")} aria-pressed={magnetic} onClick={() => onMagnetic(!magnetic)} /></div>
      <div><ToolButton icon="minus" label={translate("Reduce time line zoom")} onClick={() => setZoom((z) => Math.max(1, z / 1.5))} /><input aria-label={translate("Zoom of the timeline")} type="range" min={1} max={12} step={0.1} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} /><ToolButton icon="plus" label={translate("Expand zoom of the timeline")} onClick={() => setZoom((z) => Math.min(12, z * 1.5))} /><span className="editor-divider" /><ToolButton icon="expand" label={translate("Fit to window")} onClick={() => setZoom(1)} /></div></div>
    <div ref={viewport} className="pro-timeline-viewport">
      <div className="pro-timeline-content" style={{ width: contentWidth + LABEL + END_GUTTER }} onDragOver={dragOver} onDrop={dropAsset} onDragLeave={dragLeave}>
        <div className="pro-ruler"><span className="pro-ruler-label" /><div ref={grid} className="pro-ruler-marks" style={{ width: contentWidth }} {...scrub}>
          {marks.map((mark) => <span key={mark} style={{ left: mark * scale }}>{markStep < 1 ? mark.toFixed(2) : shortTime(mark)}</span>)}
        </div></div>
        {rows.length ? <div ref={tracks} className="pro-timeline-tracks">
          {rows.map((lane) => <div key={laneKey(lane.kind, lane.track)} className={`pro-lane pro-lane-${lane.kind}${isTarget(lane) ? " is-target" : ""}${lane.fresh ? " is-fresh" : ""}`} style={{ height: LANE_HEIGHT[lane.kind] }}>
            <div className="pro-lane-label" title={laneName(lane)}><EditorIcon name={lane.fresh ? "plus" : icons[lane.kind]} /><span className="sr-only">{laneName(lane)}</span></div>
            <div className="pro-lane-items" style={{ width: contentWidth }} {...scrub}>{lane.fresh && <span className="pro-lane-new" aria-hidden>{translate("New track")}</span>}</div>
          </div>)}
          <div className="pro-timeline-items" style={{ width: contentWidth, height: layout.height }}>
            {items.map((item) => {
              const b = box(item);
              const dragging = live?.id === item.id;
              const moving = dragging && live?.mode === "move";
              const w = Math.max(8, item.duration * scale);
              // The moved clip follows the pointer; a dashed slot shows where it lands when that is somewhere else.
              const start = room && item.kind === "video" && item.track === 0 && item.start >= room.time - 0.001 ? item.start + room.duration : item.start;
              const left = (moving && live?.float != null ? live.float : start) * scale;
              const slot = moving && Math.abs(left - item.start * scale) > 1;
              const picture = item.asset && (item.asset.kind === "video" || item.asset.kind === "image");
              return <Fragment key={item.id}>
              {slot && <div aria-hidden className="pro-clip-slot" style={{ left: item.start * scale, width: w, top: b.top, height: b.height }} />}
              <div className={`pro-timeline-clip pro-clip-${item.kind}${selected === item.id ? " is-selected" : ""}${dragging ? " is-dragging" : settling === item.id ? " is-settling" : ""}`} style={{ left, width: w, top: b.top, height: b.height }}>
                {picture && <div aria-hidden className="pro-clip-filmstrip" style={{ backgroundImage: `url("${thumbnailUrl(projectId, item.asset!)}")` }} />}
                <button type="button" className="pro-clip-body" aria-label={translate("{0} · {1} to {2} seconds. Arrows: move; up and down: change track", item.label, item.start.toFixed(2), (item.start + item.duration).toFixed(2))} title={item.label}
                  onClick={(e) => { if (e.detail === 0) onSelect(item.id); }} onKeyDown={(e) => keyboard(e, item, "move")} onPointerDown={(e) => begin(e, item, "move")}>
                  <span>{item.label}</span>{item.kind === "video" && item.asset?.hasAudio && <EditorIcon name="volume" />}
                </button>
                {moving && <span className="pro-clip-badge" aria-hidden>{onFresh ? translate("New track · ") : ""}{live?.push ? "Empuja · " : ""}{exactTime(item.start)}</span>}
                <button type="button" disabled={disabled} className="pro-trim pro-trim-in" aria-label={translate("Cut Start: {0}", item.label)} onKeyDown={(e) => keyboard(e, item, "in")} onPointerDown={(e) => begin(e, item, "in")} />
                <button type="button" disabled={disabled} className="pro-trim pro-trim-out" aria-label={translate("Final cut: {0}", item.label)} onKeyDown={(e) => keyboard(e, item, "out")} onPointerDown={(e) => begin(e, item, "out")} />
              </div>
              </Fragment>;
            })}
            {dropBox && drop && <div aria-hidden className="pro-clip-slot" style={{ left: drop.time * scale, width: Math.max(8, drop.duration * scale), top: dropBox.top, height: dropBox.height }} />}
          </div>
        </div> : <div className="pro-timeline-empty" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); e.stopPropagation(); setDrop(null); const id = e.dataTransfer.getData(ASSET_TYPE); if (id) onAdd(id, 0, null); }}><EditorIcon name="media" /><span>{translate("Here begins your assembly")}</span><button type="button" onClick={onImport}>{translate("Import files")}</button></div>}
        {!!rows.length && <div className="pro-playhead" style={{ left: LABEL + time * scale }} aria-hidden><span>{shortTime(time)}</span></div>}
        {live?.guide != null && <div className="pro-snap-guide" style={{ left: LABEL + live.guide * scale }} aria-hidden />}
        {drop && !live && !dropBox && <div className="pro-drop-marker" style={{ left: LABEL + drop.time * scale }} />}
      </div>
    </div>
  </section>;
}

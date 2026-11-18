import type { EditAsset, EditClip, EditDocument, EditOverlay } from "./schema";

export type TimelineKind = "video" | "audio" | "text" | "caption";
export interface TimelineItem { id: string; kind: TimelineKind; label: string; start: number; duration: number; track: number; clip?: EditClip; overlay?: EditOverlay; asset?: EditAsset }
export interface TimelineLane { kind: TimelineKind; track: number; items: TimelineItem[] }
export const thumbnailUrl = (projectId: string, asset: EditAsset) => `/api/projects/${projectId}/media/${asset.id}/thumbnail`;
export const frameTime = (n: number) => Math.round(n * 30) / 30;
export const shortTime = (n: number) => `${Math.floor(n / 60)}:${Math.floor(n % 60).toString().padStart(2, "0")}`;

const KINDS = ["video", "audio", "text", "caption"] as const;
const MAX = 7200;
const EPS = 0.001;
const round3 = (n: number) => Math.round(n * 1000) / 1000;
const endOf = (i: { start: number; duration: number }) => i.start + i.duration;
const overlaps = (a: { start: number; duration: number }, b: { start: number; duration: number }) => a.start < endOf(b) - EPS && b.start < endOf(a) - EPS;
const byStart = (a: { start: number }, b: { start: number }) => a.start - b.start;

/** Types a library card puts on a drag: the asset id, and its row family (readable while dragging, unlike the data). */
export const ASSET_TYPE = "application/x-videogen-asset";
export const assetKindType = (kind: "audio" | "video") => `application/x-videogen-kind-${kind}`;
const SECONDS_TYPE = "application/x-videogen-ms-";
/** How long the clip of a dragged library file would be, as one more type: the timeline draws its place before the drop. */
export const assetSecondsType = (seconds: number) => `${SECONDS_TYPE}${Math.round(seconds * 1000)}`;
export const assetSeconds = (types: readonly string[]) => Number(types.find((t) => t.startsWith(SECONDS_TYPE))?.slice(SECONDS_TYPE.length) ?? 0) / 1000 || 0;

/** Which row family an asset goes to: sound on the audio tracks, pictures on the video tracks. */
export const assetLane = (asset: Pick<EditAsset, "kind">): TimelineKind => asset.kind === "audio" ? "audio" : "video";

/**
 * Every clip and text with the track it is shown on. A saved `track` is kept unless something already
 * sits there (then the next free one up); elements without one (added by the assistant, or saved before
 * tracks existed) take the first track where they fit. `compact` renumbers the used tracks 0, 1, 2…
 */
function resolve(doc: EditDocument, compact: boolean): TimelineItem[] {
  const assets = new Map(doc.assets.map((a) => [a.id, a]));
  const all: { item: Omit<TimelineItem, "track">; raw?: number }[] = [
    ...doc.clips.map((clip) => {
      const asset = assets.get(clip.assetId);
      return { item: { id: clip.id, kind: asset ? assetLane(asset) : "video", label: asset?.name ?? "Clip", start: clip.start, duration: clip.duration, clip, asset } as const, raw: clip.track };
    }),
    ...doc.overlays.map((overlay) => ({ item: { id: overlay.id, kind: overlay.kind, label: overlay.text, start: overlay.start, duration: overlay.duration, overlay }, raw: overlay.track })),
  ];
  return KINDS.flatMap((kind) => {
    // Each lane is kept sorted by start, so whether an element fits is two neighbour checks.
    const lanes: { start: number; duration: number }[][] = [];
    const placed: [Omit<TimelineItem, "track">, number][] = [];
    const slot = (lane: { start: number }[], start: number) => {
      let lo = 0, hi = lane.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (lane[mid].start < start) lo = mid + 1; else hi = mid; }
      return lo;
    };
    const fits = (lane: { start: number; duration: number }[] | undefined, item: { start: number; duration: number }) => {
      if (!lane) return true;
      const i = slot(lane, item.start);
      return !(i > 0 && overlaps(lane[i - 1], item)) && !(i < lane.length && overlaps(lane[i], item));
    };
    // Saved tracks first, so an element without one never takes the place of one that has it.
    const ordered = all.filter((e) => e.item.kind === kind).sort((a, b) => Number(a.raw === undefined) - Number(b.raw === undefined) || byStart(a.item, b.item));
    for (const { item, raw } of ordered) {
      let t = raw ?? 0;
      while (!fits(lanes[t], item)) t++;
      const lane = (lanes[t] ??= []);
      lane.splice(slot(lane, item.start), 0, item);
      placed.push([item, t]);
    }
    const used = lanes.flatMap((lane, t) => lane?.length ? [t] : []);
    return placed.map(([item, t]): TimelineItem => ({ ...item, track: compact ? used.indexOf(t) : t }));
  });
}

/** Rows of the timeline: video tracks with the top one first (it covers the rest), then audio, texts and subtitles. */
export function timelineLanes(doc: EditDocument): TimelineLane[] {
  const lanes = new Map<string, TimelineLane>();
  for (const item of resolve(doc, true)) {
    const key = `${item.kind}:${item.track}`;
    if (!lanes.has(key)) lanes.set(key, { kind: item.kind, track: item.track, items: [] });
    lanes.get(key)!.items.push(item);
  }
  return [...lanes.values()]
    .map((lane) => ({ ...lane, items: lane.items.sort(byStart) }))
    .sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) || (a.kind === "video" ? b.track - a.track : a.track - b.track));
}

/** The elements as they are, on the track they say (no renumbering): what a drag shows while it is going on. */
export const placedItems = (doc: EditDocument) => resolve(doc, false);

/** Writes down the track every element is shown on, numbered 0, 1, 2… per kind. */
export function withTracks(doc: EditDocument): EditDocument {
  const tracks = new Map(resolve(doc, true).map((i) => [i.id, i.track]));
  const keep = <T extends { id: string; track?: number }>(x: T): T => x.track === tracks.get(x.id) ? x : { ...x, track: tracks.get(x.id) };
  return { ...doc, clips: doc.clips.map(keep), overlays: doc.overlays.map(keep) };
}

/** Clips in the order they are drawn: one on a higher video track covers the ones below; within a track, the list order. */
export function layeredClips(doc: EditDocument): EditClip[] {
  const tracks = new Map(resolve({ ...doc, overlays: [] }, true).map((i) => [i.id, i.track]));
  return doc.clips.map((clip, index) => ({ clip, index, track: tracks.get(clip.id) ?? 0 }))
    .sort((a, b) => a.track - b.track || a.index - b.index).map((x) => x.clip);
}

type Patch = { start?: number; duration?: number; in?: number; track?: number };
function apply(doc: EditDocument, updates: Map<string, Patch>): EditDocument {
  if (!updates.size) return doc;
  return {
    ...doc,
    clips: doc.clips.map((c) => updates.has(c.id) ? { ...c, ...updates.get(c.id) } : c),
    overlays: doc.overlays.map((o) => {
      const u = updates.get(o.id);
      return u ? { ...o, ...(u.start !== undefined && { start: u.start }), ...(u.duration !== undefined && { duration: u.duration }), ...(u.track !== undefined && { track: u.track }) } : o;
    }),
  };
}

const isMain = (i: TimelineItem) => i.kind === "video" && i.track === 0;

/**
 * The magnetic main track: the picture clips of video track 0 play back to back from 0, in `order`
 * (by default, the order they are in), so nothing there leaves a black gap or overlaps.
 */
function packMain(doc: EditDocument, order?: string[]): EditDocument {
  // The saved tracks as they are (callers wrote them all down): a clip just put on the track may still overlap others.
  const kinds = new Map(doc.assets.map((a) => [a.id, a.kind]));
  const main = doc.clips.filter((c) => kinds.get(c.assetId) !== "audio" && (c.track ?? 0) === 0).sort(byStart);
  const byId = new Map(main.map((i) => [i.id, i]));
  const updates = new Map<string, Patch>();
  let cursor = 0;
  for (const id of order ?? main.map((i) => i.id)) {
    const item = byId.get(id);
    if (!item) continue;
    if (Math.abs(item.start - cursor) > EPS) updates.set(id, { start: round3(cursor) });
    cursor = round3(cursor + item.duration);
  }
  return apply(doc, updates);
}

/**
 * Where a clip goes on the magnetic main track: the cut (between two clips, or either end) nearest to
 * `at`, that is, before the first clip whose middle is past it. `exclude` is the clip being moved: the
 * cuts are where they are without it, with the gap it leaves on that track closed.
 */
export function mainInsertion(doc: EditDocument, at: number, exclude?: string): { index: number; time: number } {
  const all = resolve(doc, false).filter(isMain).sort(byStart);
  const gone = all.find((i) => i.id === exclude);
  const main = all.filter((i) => i !== gone).map((i) => gone && i.start > gone.start ? { ...i, start: i.start - gone.duration } : i);
  const index = main.filter((i) => i.start + i.duration / 2 <= at).length;
  return { index, time: index ? round3(endOf(main[index - 1])) : 0 };
}

/**
 * The start nearest to `start` where something `duration` long fits on a track holding `others`
 * without touching any of them; null when the track has no room left.
 */
export function freeStart(others: { start: number; duration: number }[], start: number, duration: number): number | null {
  const sorted = [...others].sort(byStart);
  let best: number | null = null, from = 0;
  for (let i = 0; i <= sorted.length; i++) {
    const to = i < sorted.length ? sorted[i].start : MAX;
    if (to - from >= duration - EPS) {
      const fit = Math.max(from, Math.min(to - duration, start));
      if (best === null || Math.abs(fit - start) < Math.abs(best - start)) best = fit;
    }
    if (i < sorted.length) from = Math.max(from, endOf(sorted[i]));
  }
  return best;
}

export interface MoveTarget {
  /** Wanted start (s), already snapped. */
  start: number;
  /** Track of the element's kind; one past the last one opens a new track. */
  track: number;
  /** On the magnetic main track the clip goes to the cut nearest to this time (s). */
  at: number;
  /** Make room instead of looking for it: what follows on the track moves just as far as needed. */
  push?: boolean;
}

/**
 * Moves an element to another time and/or track. Elements of one track never overlap, and a move
 * leaves the others where they are: the element lands on the free place nearest to where it is put
 * (against a neighbour, or past it once it is more than halfway over). With `push` it stays where it
 * is put instead, before or after the element under its left edge (whichever half it is in), and what
 * follows on that track moves along. With `magnetic`, the main video track stays packed: a clip put
 * there is inserted at the nearest cut, and one taken out of it closes its gap.
 */
export function moveItem(base: EditDocument, id: string, target: MoveTarget, magnetic: boolean): EditDocument {
  const doc = withTracks(base);
  const items = placedItems(doc);
  const item = items.find((i) => i.id === id);
  if (!item) return doc;
  const lane = items.filter((i) => i.kind === item.kind && i.track === target.track && i.id !== id).sort(byStart);
  if (magnetic && item.kind === "video" && target.track === 0) {
    const { index } = mainInsertion(doc, target.at, id);
    const order = lane.map((i) => i.id);
    order.splice(index, 0, id);
    return packMain(apply(doc, new Map([[id, { track: 0 }]])), order);
  }
  const updates = new Map<string, Patch>();
  let start = Math.max(0, Math.min(MAX - item.duration, target.start));
  if (!target.push) {
    const free = freeStart(lane, start, item.duration);
    if (free === null) return doc;
    start = free;
  } else if (lane.some((o) => overlaps(o, { start, duration: item.duration }))) {
    const under = lane.find((o) => o.start - EPS <= start && start < endOf(o) - EPS);
    if (under) start = start < under.start + under.duration / 2 ? under.start : endOf(under);
    let cursor = start + item.duration;
    for (const o of lane) {
      if (o.start < start - EPS) continue;
      if (o.start >= cursor - EPS) break;
      const pushed = round3(cursor);
      updates.set(o.id, { start: pushed });
      cursor = pushed + o.duration;
    }
  }
  updates.set(id, { start: round3(start), track: target.track });
  const next = apply(doc, updates);
  // Taken out of the magnetic main track: the clips after it close the gap.
  return magnetic && isMain(item) ? packMain(next) : next;
}

/**
 * Trims the start (`in`) or end (`out`) of an element by `delta` seconds. It stops at its neighbours on
 * the track and at what its file has; on the magnetic main track the rest of the track follows instead.
 */
export function trimItem(base: EditDocument, id: string, edge: "in" | "out", delta: number, magnetic: boolean): EditDocument {
  const doc = withTracks(base);
  const items = placedItems(doc);
  const item = items.find((i) => i.id === id);
  if (!item) return doc;
  const lane = items.filter((i) => i.kind === item.kind && i.track === item.track && i.id !== id);
  const ripple = magnetic && isMain(item);
  let d = delta;
  if (!ripple && edge === "in") d = Math.max(d, Math.max(0, ...lane.filter((o) => endOf(o) <= item.start + EPS).map(endOf)) - item.start);
  if (!ripple && edge === "out") d = Math.min(d, Math.min(MAX, ...lane.filter((o) => o.start >= endOf(item) - EPS).map((o) => o.start)) - endOf(item));
  const patch = retimeItem(item, d, edge, ripple);
  const next = apply(doc, new Map([[id, { start: round3(patch.start), duration: round3(patch.duration), ...(patch.in !== undefined && { in: round3(patch.in) }) }]]));
  return ripple ? packMain(next, [...lane, item].sort(byStart).map((i) => i.id)) : next;
}

/** Removes elements; with `magnetic`, the main track closes the gaps they leave. */
export function removeItems(base: EditDocument, ids: string[], magnetic: boolean): EditDocument {
  const doc = withTracks(base);
  const gone = new Set(ids);
  const fromMain = placedItems(doc).some((i) => gone.has(i.id) && isMain(i));
  const next = { ...doc, clips: doc.clips.filter((c) => !gone.has(c.id)), overlays: doc.overlays.filter((o) => !gone.has(o.id)) };
  return magnetic && fromMain ? packMain(next) : next;
}

/** Moves `start` so the element's start or end lands on the nearest anchor within `tolerance`; `guide` is that anchor. */
export function snapSpan(start: number, duration: number, anchors: number[], tolerance: number): { start: number; guide: number | null } {
  let best = tolerance, result: { start: number; guide: number | null } = { start: frameTime(start), guide: null };
  for (const a of anchors) {
    if (Math.abs(a - start) < best) { best = Math.abs(a - start); result = { start: a, guide: a }; }
    if (Math.abs(a - start - duration) < best) { best = Math.abs(a - start - duration); result = { start: a - duration, guide: a }; }
  }
  return result;
}

export function snapTime(value: number, anchors: number[], tolerance: number): number {
  const nearest = anchors.reduce((best, anchor) => Math.abs(anchor - value) < Math.abs(best - value) ? anchor : best, value + tolerance + 1);
  return Math.abs(nearest - value) <= tolerance ? nearest : frameTime(value);
}

/**
 * Trimming a clip moves its source offset with its left edge, preserving audio sync. `packed` is a
 * clip of the magnetic main track: its start is given back by the track, so the start of the timeline
 * does not stop its left edge from opening (only its file does).
 */
export function retimeItem(item: TimelineItem, delta: number, mode: "move" | "in" | "out", packed = false): { start: number; duration: number; in?: number } {
  const minDuration = 0.04;
  if (mode === "move") return { start: Math.max(0, Math.min(MAX - item.duration, item.start + delta)), duration: item.duration };
  const speed = item.clip?.speed ?? 1;
  if (mode === "in") {
    const floor = packed ? item.duration - MAX : -item.start;
    const min = Math.max(floor, item.clip && item.asset?.kind !== "image" ? -item.clip.in / speed : floor);
    const shift = Math.max(min, Math.min(item.duration - minDuration, delta));
    return { start: item.start + shift, duration: item.duration - shift, ...(item.clip && item.asset?.kind !== "image" ? { in: item.clip.in + shift * speed } : {}) };
  }
  const remaining = item.clip && item.asset?.kind !== "image" ? ((item.asset?.duration ?? 0) - item.clip.in) / speed : MAX - item.start;
  return { start: item.start, duration: Math.max(minDuration, Math.min(remaining, MAX - item.start, item.duration + delta)) };
}

/** A save response may advance the revision while the user continues editing. */
export function mergeSavedEdit(current: EditDocument, sent: EditDocument, saved: EditDocument): EditDocument {
  if (JSON.stringify({ ...current, revision: sent.revision }) === JSON.stringify(sent)) return saved;
  return { ...current, revision: saved.revision, assets: saved.assets };
}

/** Follow the last element when the duration was fitted to content; retain an explicit minimum. */
export function fitChangedTimeline(current: EditDocument, next: EditDocument): EditDocument {
  const end = (doc: EditDocument) => Math.max(0, ...[...doc.clips, ...doc.overlays].map((item) => item.start + item.duration));
  if (next.duration !== current.duration || Math.abs(current.duration - end(current)) > 0.01) return next;
  return { ...next, duration: Math.max(0.1, end(next)) };
}

import { t as translate } from "@/lib/i18n";
import { z } from "zod";
import { editClipSchema, overlaySchema, editDocumentSchema, editDuration, type EditClip, type EditDocument, type EditOverlay } from "./schema";
import { FPS, transitionLength } from "./motion";

const itemId = z.string().min(1).max(80);
const shiftFrames = z.number().int().min(-216000).max(216000).optional()
  .describe("Relative displacement: -3 advances three frames to 30 fps. It does not change the duration.");

export const editNotesSchema = z.object({
  expectedRevision: z.number().int().nonnegative().describe("Review of the current state; avoid overwriting changes to another window or tool."),
  range: z.object({ from: z.number().min(0).max(7200), to: z.number().min(0).max(7200) })
    .refine((r) => r.to > r.from, "The end must go after the start.").optional()
    .describe("Only if the user limits the note to a section. It rejects elements that extend outside; it does not cut or move other elements."),
  clips: z.array(z.object({
    id: itemId,
    set: editClipSchema.omit({ id: true, assetId: true }).extend({
      transition: editClipSchema.shape.transition.removeDefault(), motion: editClipSchema.shape.motion.removeDefault(),
    }).partial().strict().optional(),
    shiftFrames,
    volumeFactor: z.number().min(0).max(2).optional().describe("It multiplies the ACTUAL volume of this clip; 0.5 leaves it in half. Only for the affected sounds."),
  }).strict()).max(500).optional(),
  overlays: z.array(z.object({
    id: itemId,
    set: overlaySchema.omit({ id: true, kind: true }).partial().strict().optional(),
    shiftFrames,
  }).strict()).max(3000).optional(),
  removeClipIds: z.array(itemId).max(500).optional(),
  removeOverlayIds: z.array(itemId).max(3000).optional(),
  addClips: z.array(editClipSchema.omit({ id: true }).strict()).max(500).optional(),
  addOverlays: z.array(overlaySchema.omit({ id: true }).strict()).max(3000).optional(),
}).strict();

export type EditNotes = z.infer<typeof editNotesSchema>;
export interface NoteChange {
  kind: "clip" | "overlay";
  id: string;
  before?: EditClip | EditOverlay;
  after?: EditClip | EditOverlay;
  fields: string[];
}
export interface NoteReview {
  revision: number;
  range?: { from: number; to: number };
  changes: NoteChange[];
  times: number[];
  reviewed: Set<number>;
  unavailable: Set<number>;
}
export const NOTE_REVIEW_PAGE_SIZE = 12;

const end = (item: { start: number; duration: number }) => item.start + item.duration;

function fields(before: NoteChange["before"], after: NoteChange["after"]): string[] {
  const a = (before ?? {}) as Record<string, unknown>, b = (after ?? {}) as Record<string, unknown>;
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
}

/** ID patches never rebuild, pack, normalise tracks or retime anything outside the supplied items. */
export function applyEditNotes(doc: EditDocument, input: EditNotes): { doc: EditDocument; changes: NoteChange[] } {
  if (input.expectedRevision !== doc.revision) throw new Error(translate("The assembly has changed. Read review_edit and use the current review ({0}); do not repeat an old state.", doc.revision));
  const changes: NoteChange[] = [];
  const seen = new Set<string>();
  const record = (kind: NoteChange["kind"], before: NoteChange["before"], after: NoteChange["after"]) => {
    const id = (before ?? after)!.id;
    if (seen.has(id)) throw new Error(translate("\"{0}\" appears more than once in the note. It combines your changes in a single operation.", id));
    seen.add(id);
    for (const item of [before, after]) {
      if (!item) continue;
      if (input.range && (item.start < input.range.from - 1e-6 || end(item) > input.range.to + 1e-6)) {
        throw new Error(translate("\"{0} 'is extended outside the approved tranche. Nothing has been saved; it explicitly divides that element before limiting the note to the tranche.", id));
      }
      if (end(item) > editDuration(doc) + 1e-6) throw new Error(translate("\"{0}\" would extend the assembly. Just adjust that element within the current duration.", id));
    }
    const changed = fields(before, after);
    if (changed.length) changes.push({ kind, id, before, after, fields: changed });
  };
  const clipUpdates = new Map((input.clips ?? []).map((u) => [u.id, u]));
  const overlayUpdates = new Map((input.overlays ?? []).map((u) => [u.id, u]));
  const removeClips = new Set(input.removeClipIds ?? []), removeOverlays = new Set(input.removeOverlayIds ?? []);
  for (const [updates, removals, items] of [
    [input.clips ?? [], input.removeClipIds ?? [], doc.clips],
    [input.overlays ?? [], input.removeOverlayIds ?? [], doc.overlays],
  ] as const) {
    const ids = [...updates.map((u) => u.id), ...removals];
    if (new Set(ids).size !== ids.length) throw new Error("Hay identificadores repetidos entre las actualizaciones y eliminaciones.");
    for (const id of ids) if (!items.some((item) => item.id === id)) throw new Error(`«${id}» no existe. Lee el estado actual antes de aplicar la nota.`);
  }
  const clips = doc.clips.flatMap((before) => {
    if (removeClips.has(before.id)) { record("clip", before, undefined); return []; }
    const update = clipUpdates.get(before.id);
    if (!update) return [before];
    if (update.shiftFrames !== undefined && update.set?.start !== undefined) throw new Error(translate("Use start or shiftFrames, not both."));
    if (update.volumeFactor !== undefined && update.set?.volume !== undefined) throw new Error(translate("Use volume or volumFactor, not both."));
    const after = editClipSchema.parse({ ...before, ...update.set,
      ...(update.shiftFrames !== undefined && { start: before.start + update.shiftFrames / FPS }),
      ...(update.volumeFactor !== undefined && { volume: before.volume * update.volumeFactor }),
    });
    record("clip", before, after);
    return [after];
  });
  const overlays = doc.overlays.flatMap((before) => {
    if (removeOverlays.has(before.id)) { record("overlay", before, undefined); return []; }
    const update = overlayUpdates.get(before.id);
    if (!update) return [before];
    if (update.shiftFrames !== undefined && update.set?.start !== undefined) throw new Error(translate("Use start or shiftFrames, not both."));
    const after = overlaySchema.parse({ ...before, ...update.set,
      ...(update.shiftFrames !== undefined && { start: before.start + update.shiftFrames / FPS }),
    });
    record("overlay", before, after);
    return [after];
  });
  for (const item of input.addClips ?? []) {
    const after = editClipSchema.parse({ ...item, id: crypto.randomUUID() });
    record("clip", undefined, after); clips.push(after);
  }
  for (const item of input.addOverlays ?? []) {
    const after = overlaySchema.parse({ ...item, id: crypto.randomUUID() });
    record("overlay", undefined, after); overlays.push(after);
  }
  // Parse the complete result before saving: every source trim and reference stays subject to the normal rules.
  const next = editDocumentSchema.parse({ ...doc, clips, overlays });
  if (Math.abs(editDuration(next) - editDuration(doc)) > 1e-6) throw new Error(translate("The note would change the total duration. Nothing has been saved; it retains the end of the assembly by modifying its elements."));
  return { doc: next, changes };
}

/** Every affected span: first/last output frame, middle, each second, cut and layer boundary on either side. */
export function noteReviewTimes(doc: EditDocument, changes: NoteChange[]): number[] {
  const picture = doc.clips.filter((c) => {
    const asset = doc.assets.find((a) => a.id === c.assetId);
    return asset?.kind === "video" || asset?.kind === "image";
  });
  const ranges = changes.flatMap((change) => {
    // Pure gain changes are checked numerically. Timing/addition/removal of an audio cue also needs
    // picture context at its affected times, though the snapshots do not audition that sound.
    if (change.kind === "clip" && change.before && change.after && change.fields.every((field) => field === "volume")) return [];
    return [change.before, change.after].filter((item): item is EditClip | EditOverlay => !!item);
  });
  const boundaries = [...picture.flatMap((c) => [c.start, c.start + transitionLength(c), end(c)]), ...doc.overlays.flatMap((o) => [o.start, end(o)])];
  const frames = new Set<number>();
  const lastFrame = Math.ceil(editDuration(doc) * FPS) - 1;
  for (const range of ranges) {
    const first = Math.max(0, Math.ceil(range.start * FPS - 1e-6));
    const last = Math.min(lastFrame, Math.ceil(end(range) * FPS - 1e-6) - 1);
    if (last < first) continue;
    const add = (frame: number) => { if (frame >= first && frame <= last) frames.add(frame); };
    // Read-only context immediately outside a change helps spot spillover without editing its neighbours.
    if (first > 0) frames.add(first - 1);
    if (last < lastFrame) frames.add(last + 1);
    add(first); add(last); add(Math.floor((first + last) / 2));
    for (let frame = first; frame <= last; frame += FPS) add(frame);
    for (const boundary of boundaries) {
      const frame = Math.ceil(boundary * FPS - 1e-6);
      add(frame - 1); add(frame);
    }
  }
  return [...frames].sort((a, b) => a - b).map((frame) => frame / FPS);
}

/** Keep the first value and the latest value across corrective passes of the same note. */
export function accumulateNoteReview(previous: NoteReview | undefined, doc: EditDocument, changes: NoteChange[], range?: NoteReview["range"]): NoteReview {
  const all = new Map((previous?.changes ?? []).map((change) => [`${change.kind}:${change.id}`, change]));
  for (const change of changes) {
    const key = `${change.kind}:${change.id}`, first = all.get(key);
    const before = first ? first.before : change.before;
    const changed = fields(before, change.after);
    if (!changed.length) all.delete(key);
    else all.set(key, { ...change, before, fields: changed });
  }
  const combined = [...all.values()];
  return { revision: doc.revision, range: previous?.range ?? range, changes: combined, times: noteReviewTimes(doc, combined), reviewed: new Set(), unavailable: new Set() };
}

export function pendingNotePages(review: NoteReview): number[] {
  return Array.from({ length: Math.ceil(review.times.length / NOTE_REVIEW_PAGE_SIZE) }, (_, page) => page)
    .filter((page) => !review.reviewed.has(page) && !review.unavailable.has(page));
}

export function describeNoteChanges(changes: NoteChange[]): string {
  return changes.map((change) => {
    const pick = (item: NoteChange["before"]) => item && Object.fromEntries(change.fields.map((field) => [field, (item as Record<string, unknown>)[field]]));
    const item = change.after ?? change.before!;
    return `${change.kind} ${change.id} (${item.start.toFixed(3)}–${end(item).toFixed(3)} s): ${JSON.stringify({ before: pick(change.before), after: pick(change.after) })}`;
  }).join("\n");
}

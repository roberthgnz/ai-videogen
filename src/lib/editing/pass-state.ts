import { t as translate } from "@/lib/i18n";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { storagePaths } from "@/lib/storage";
import { EDIT_PASSES, PASS_MODES, PASS_STATUSES, type EditPass } from "./passes-shared";
import type { EditDocument } from "./schema";

const passEntrySchema = z.object({
  status: z.enum(PASS_STATUSES).catch("pending"),
  note: z.string().max(1000).catch(""),
  updatedAt: z.string().nullable().catch(null),
  versionId: z.string().nullable().catch(null),
  reviewVersionId: z.string().nullable().catch(null),
});
export const emptyEntry = () => ({ status: "pending" as const, note: "", updatedAt: null, versionId: null, reviewVersionId: null });
export const passMapSchema = z.object(Object.fromEntries(EDIT_PASSES.map((p) => [p, passEntrySchema.catch(emptyEntry)])) as Record<EditPass, z.ZodCatch<typeof passEntrySchema>>);
export const emptyPasses = () => Object.fromEntries(EDIT_PASSES.map((p) => [p, emptyEntry()])) as z.infer<typeof passMapSchema>;
const stateSchema = z.object({
  mode: z.enum(PASS_MODES).catch("guided"),
  /** Which passes this video needs was decided (a skipped one is «skipped»); see isPlanned. */
  planned: z.boolean().catch(false),
  passes: passMapSchema.catch(emptyPasses),
});
export type PassState = z.infer<typeof stateSchema>;

/** The plan was chosen, or a project from before plans already moved its passes (then all four are in it). */
export const isPlanned = (state: PassState) => state.planned || EDIT_PASSES.some((p) => state.passes[p].status !== "pending");

export function passFolder(projectId: string): string {
  if (!/^[a-f0-9-]{36}$/i.test(projectId)) throw new Error(translate("Project not found."));
  const root = storagePaths.project(projectId);
  const current = path.join(root, "versions");
  const legacy = path.join(root, "versiones");
  return !fs.existsSync(current) && fs.existsSync(legacy) ? legacy : current;
}
export function readPassJson(file: string): unknown {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return undefined; }
}
export function writePassJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}
export function readPassState(projectId: string): PassState {
  return stateSchema.parse(readPassJson(path.join(passFolder(projectId), "pasadas.json")) ?? {});
}
export function writePassState(projectId: string, state: PassState) {
  writePassJson(path.join(passFolder(projectId), "pasadas.json"), state);
}

/** Revoke decisions, never rebuild or remove the user's montage or its saved versions. */
export function invalidateFrom(state: PassState, pass: EditPass, includeSelf: boolean, reason: string): PassState {
  const passes = { ...state.passes };
  for (const p of EDIT_PASSES.slice(EDIT_PASSES.indexOf(pass) + (includeSelf ? 0 : 1))) {
    const entry = passes[p];
    // After an edit, a pass being worked on stays so, even when an earlier layer changed under it (the agent
    // nudging a subtitle during the graphics pass): it will be reviewed anyway, and resetting it would make
    // mark_pass_ready fail. Reopening an earlier pass (includeSelf false) does put a later one back to pending.
    if (includeSelf && entry.status === "working") continue;
    // A pass this video does not need stays out of the plan: editing that layer by hand does not bring it back.
    if (entry.status === "skipped") continue;
    if (entry.status === "pending" && !entry.versionId && !entry.reviewVersionId) continue;
    passes[p] = { ...emptyEntry(), note: reason, updatedAt: new Date().toISOString() };
  }
  return { ...state, passes };
}

/** Earliest pass whose inputs changed. Proposals, asset registration and analysis alone do not dirty a pass. */
function changedPass(before: EditDocument, after: EditDocument): EditPass | null {
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const visual = (doc: EditDocument) => doc.clips.filter((c) => ["video", "image"].includes(doc.assets.find((a) => a.id === c.assetId)?.kind ?? ""));
  const cuts = (doc: EditDocument) => visual(doc).map(({ id, assetId, start, in: input, duration, speed, track }) => ({ id, assetId, start, in: input, duration, speed: speed ?? 1, track: track ?? 0 }));
  if (before.duration !== after.duration || !same(cuts(before), cuts(after))) return "cut";
  if (!same(before.overlays.filter((o) => o.kind === "caption"), after.overlays.filter((o) => o.kind === "caption"))
    || !same(before.transcript?.corrections ?? [], after.transcript?.corrections ?? [])
    || !same(before.transcript?.highlight ?? null, after.transcript?.highlight ?? null)) return "captions";
  const graphics = (doc: EditDocument) => visual(doc).map(({ id, fit, transition, motion }) => ({ id, fit, transition, motion }));
  if (before.background !== after.background || !same(graphics(before), graphics(after))
    || !same(before.overlays.filter((o) => o.kind === "text"), after.overlays.filter((o) => o.kind === "text"))) return "graphics";
  const sound = (doc: EditDocument) => doc.clips.filter((c) => { const asset = doc.assets.find((a) => a.id === c.assetId); return asset?.kind === "audio" || asset?.hasAudio; })
    .map(({ id, assetId, start, in: input, duration, speed, volume }) => ({ id, assetId, start, in: input, duration, speed: speed ?? 1, volume }));
  return same(sound(before), sound(after)) ? null : "sound";
}

/** Shared save boundary: manual edits and agent tools invalidate exactly the same approvals. */
export function invalidatePassesForEdit(projectId: string, before: EditDocument, after: EditDocument, formatChanged = false) {
  const pass = formatChanged ? "cut" : changedPass(before, after);
  if (!pass) return;
  const state = readPassState(projectId);
  const next = invalidateFrom(state, pass, true, translate("Review the pass after changing the edit."));
  if (JSON.stringify(state) !== JSON.stringify(next)) writePassState(projectId, next);
}

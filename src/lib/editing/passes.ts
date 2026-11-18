import { t as translate, getLocale } from "@/lib/i18n";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { getProject } from "@/lib/projects";
import { saveEditDocument } from "./repository";
import { emptyEntry, emptyPasses, invalidateFrom, invalidatePassesForEdit, isPlanned, passFolder as folder, passMapSchema, readPassJson as readJson, readPassState, writePassJson as writeJson, writePassState, type PassState } from "./pass-state";
import { editDocumentSchema, editDuration, referenceAssetIds, type EditDocument } from "./schema";
import {
  EDIT_PASSES,
  nextPass,
  PASS_INFO,
  PASS_MODE_INFO,
  PASS_MODES,
  PASS_STATUS_LABELS,
  passList,
  VERSION_KIND_LABELS,
  VERSION_KINDS,
  type EditPass,
  type PassesView,
  type PassMode,
  type VersionKind,
  type VersionView,
} from "./passes-shared";

export { readPassState, type PassState } from "./pass-state";

/**
 * Editing in passes with saved versions. Kept on disk with the project, next to its media
 * (`projects/<id>/versions/`): small JSON files, like the app's settings and the agent's session, so they
 * need no migration, go away with the project and never travel with every save of the montage.
 *
 * - `pasadas.json`: the mode and where each pass stands.
 * - `indice.json`: the list of versions (names, kinds, what each one holds).
 * - `<id>.json`: the montage of one version.
 *
 * A version is the montage (clips, texts, length, background, chosen resources), independent of the chat:
 * going back to one keeps the project's files and references, and saves what there was first.
 */

/** Past this, the oldest automatic versions (left for review, copies before going back) are removed. */
const MAX_VERSIONS = 80;

type PassEntry = PassState["passes"][EditPass];

const versionMetaSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(VERSION_KINDS),
  pass: z.enum(EDIT_PASSES).nullable(),
  createdAt: z.string(),
  /** Of the montage, to tell two versions with the same content apart from different ones. */
  fingerprint: z.string(),
  fingerprintVersion: z.literal(2).optional(),
  clips: z.number(),
  overlays: z.number(),
  duration: z.number(),
  /** Where the passes stood when it was saved: going back to it puts them back too. */
  passes: passMapSchema.catch(emptyPasses),
  mode: z.enum(PASS_MODES).optional(),
  planned: z.boolean().optional(),
});
type VersionMeta = z.infer<typeof versionMetaSchema>;

const VERSION_ID = /^[a-f0-9-]{36}$/;

// ---------------------------------------------------------------- files

function readIndex(projectId: string): VersionMeta[] {
  const raw = readJson(path.join(folder(projectId), "indice.json"));
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    const parsed = versionMetaSchema.safeParse(item);
    if (!parsed.success) return [];
    if (parsed.data.fingerprintVersion === 2) return [parsed.data];
    // Old indexes did not hash transcript state. Derive it from their existing snapshots too.
    const edit = readSnapshot(projectId, parsed.data.id);
    return [{ ...parsed.data, fingerprint: edit ? fingerprint(edit) : parsed.data.fingerprint, ...(edit ? { fingerprintVersion: 2 as const } : {}) }];
  });
}

function writeIndex(projectId: string, index: VersionMeta[]) {
  writeJson(path.join(folder(projectId), "indice.json"), index);
}

function readSnapshot(projectId: string, id: string): EditDocument | null {
  if (!VERSION_ID.test(id)) return null;
  const raw = readJson(path.join(folder(projectId), `${id}.json`)) as { edit?: unknown } | undefined;
  const parsed = editDocumentSchema.safeParse(raw?.edit);
  return parsed.success ? parsed.data : null;
}

// ---------------------------------------------------------------- montage

/** What a version restores: the montage, not the project's files or references. */
function montageOf(edit: EditDocument) {
  return { enabled: edit.enabled, duration: edit.duration, background: edit.background, direction: edit.direction, clips: edit.clips, overlays: edit.overlays, transcript: edit.transcript };
}

const fingerprint = (edit: EditDocument) => createHash("sha1").update(JSON.stringify(montageOf(edit))).digest("hex");

const decimal = (n: number) => n.toLocaleString(getLocale(), { maximumFractionDigits: 1 });
function summaryOf(meta: Pick<VersionMeta, "clips" | "overlays" | "duration">): string {
  return `${meta.clips} ${meta.clips === 1 ? "clip" : "clips"} · ${meta.overlays} ${meta.overlays === 1 ? "texto" : "textos"} · ${decimal(meta.duration)} s`;
}

function currentEdit(projectId: string): EditDocument {
  const p = getProject(projectId);
  if (!p) throw new Error(translate("Project not found."));
  return p.edit;
}

// ---------------------------------------------------------------- versions

/** Saves `edit` (by default the montage as it is now) as a new version. */
export function saveVersion(projectId: string, name: string, kind: VersionKind, options: { pass?: EditPass | null; edit?: EditDocument; id?: string } = {}): VersionView {
  const title = name.trim().replace(/\s+/g, " ").slice(0, 80);
  if (!title) throw new Error(translate("Put a name on the version."));
  const edit = options.edit ?? currentEdit(projectId);
  const state = readPassState(projectId);
  const meta: VersionMeta = {
    id: options.id ?? crypto.randomUUID(), name: title, kind, pass: options.pass ?? null, createdAt: new Date().toISOString(),
    fingerprint: fingerprint(edit), fingerprintVersion: 2, clips: edit.clips.length, overlays: edit.overlays.length,
    duration: Math.round(editDuration(edit) * 10) / 10, passes: state.passes, mode: state.mode, planned: state.planned,
  };
  const dir = folder(projectId);
  writeJson(path.join(dir, `${meta.id}.json`), { id: meta.id, name: meta.name, edit });
  const index = [...readIndex(projectId), meta];
  // Only versions the app made on its own make way; the ones a person asked for, or approved, always stay.
  while (index.length > MAX_VERSIONS) {
    const oldest = index.findIndex((v) => v.kind === "review" || v.kind === "backup");
    if (oldest < 0) break;
    const [removed] = index.splice(oldest, 1);
    fs.rmSync(path.join(dir, `${removed.id}.json`), { force: true });
  }
  writeIndex(projectId, index);
  return toView(meta);
}

function samePassState(meta: VersionMeta, state: PassState): boolean {
  return (meta.mode ?? state.mode) === state.mode && (meta.planned ?? state.planned) === state.planned && JSON.stringify(meta.passes) === JSON.stringify(state.passes);
}

function toView(meta: VersionMeta, now?: string, state?: PassState): VersionView {
  return { id: meta.id, name: meta.name, kind: meta.kind, pass: meta.pass, createdAt: meta.createdAt, summary: summaryOf(meta), current: meta.fingerprint === now && (!state || samePassState(meta, state)) };
}

/** Newest first. `edit`: the montage saved now, when the caller has it already. */
export function listVersions(projectId: string, edit = getProject(projectId)?.edit): VersionView[] {
  const now = edit ? fingerprint(edit) : undefined;
  const state = readPassState(projectId);
  return readIndex(projectId).reverse().map((meta) => toView(meta, now, state));
}

/** By id, or by name (the newest with that name), as the agent may refer to it. */
export function findVersion(projectId: string, idOrName: string): VersionView | null {
  const wanted = idOrName.trim();
  const index = readIndex(projectId);
  const found = index.find((v) => v.id === wanted) ?? [...index].reverse().find((v) => v.name.toLowerCase() === wanted.replace(/^[«"']|[»"']$/g, "").toLowerCase());
  return found ? toView(found) : null;
}

/**
 * Gives a version another name. A version the app saved on its own (left for review, a copy before going
 * back) becomes the user's once they name it, so it is never removed to make room.
 */
export function renameVersion(projectId: string, versionId: string, name: string): VersionView {
  const title = name.trim().replace(/\s+/g, " ").slice(0, 80);
  if (!title) throw new Error(translate("Put a name on the version."));
  const index = readIndex(projectId);
  const meta = index.find((v) => v.id === versionId);
  if (!meta) throw new Error(translate("That version is no longer saved."));
  meta.name = title;
  if (meta.kind === "review" || meta.kind === "backup") meta.kind = "manual";
  writeIndex(projectId, index);
  return toView(meta);
}

/**
 * Removes a version for good. The montage as it is now does not change, and a pass approved with it stays
 * approved: the version was a copy, the approval is the user's decision.
 */
export function deleteVersion(projectId: string, versionId: string): VersionView {
  const index = readIndex(projectId);
  const meta = index.find((v) => v.id === versionId);
  if (!meta) throw new Error(translate("That version is no longer saved."));
  writeIndex(projectId, index.filter((v) => v.id !== versionId));
  if (VERSION_ID.test(versionId)) fs.rmSync(path.join(folder(projectId), `${versionId}.json`), { force: true });
  // The passes stop pointing at it (an approval with no version, a review with nothing to approve from).
  const state = readPassState(projectId);
  const passes = Object.fromEntries(EDIT_PASSES.map((p) => [p, {
    ...state.passes[p],
    versionId: state.passes[p].versionId === versionId ? null : state.passes[p].versionId,
    reviewVersionId: state.passes[p].reviewVersionId === versionId ? null : state.passes[p].reviewVersionId,
  }])) as PassState["passes"];
  if (JSON.stringify(passes) !== JSON.stringify(state.passes)) writePassState(projectId, { ...state, passes });
  return toView(meta);
}

export interface RestoreResult {
  edit: EditDocument;
  version: VersionView;
  /** The copy of what there was before, or null when it was already saved as a version. */
  backup: VersionView | null;
  /** Clips left out because their file is no longer in the project, or is a reference now. */
  dropped: number;
}

/**
 * Goes back to a version: its montage and where the passes stood. What there was before is saved first
 * (unless a version already holds exactly that), so going back never loses anything.
 */
export function restoreVersion(projectId: string, versionId: string): RestoreResult {
  const index = readIndex(projectId);
  const meta = index.find((v) => v.id === versionId);
  const snapshot = meta && readSnapshot(projectId, meta.id);
  if (!meta || !snapshot) throw new Error(translate("That version is no longer saved."));
  const current = currentEdit(projectId);
  const now = fingerprint(current);
  const state = readPassState(projectId);
  let backup: VersionView | null = null;
  if ((now !== meta.fingerprint || !samePassState(meta, state)) && !index.some((v) => v.fingerprint === now && samePassState(v, state))) {
    backup = saveVersion(projectId, `Antes de volver a «${meta.name}»`, "backup", { edit: current });
  }
  // Files and references are the project's, not the version's: they stay as they are now.
  const guides = referenceAssetIds(current);
  const clips = snapshot.clips.filter((c) => current.assets.some((a) => a.id === c.assetId) && !guides.has(c.assetId));
  const edit = saveEditDocument(projectId, { ...current, ...montageOf(snapshot), direction: snapshot.direction, clips, revision: current.revision }, true);
  writePassState(projectId, { mode: meta.mode ?? state.mode, planned: meta.planned ?? state.planned, passes: meta.passes });
  // Missing project assets mean this is no longer the exact approved montage.
  if (clips.length !== snapshot.clips.length) invalidatePassesForEdit(projectId, snapshot, edit);
  return { edit, version: toView(meta), backup, dropped: snapshot.clips.length - clips.length };
}

// ---------------------------------------------------------------- passes

const skippedIn = (state: PassState) => (p: EditPass) => state.passes[p].status === "skipped";

/** The passes this video needs, in order. */
export const planOf = (state: PassState) => EDIT_PASSES.filter((p) => state.passes[p].status !== "skipped");

/** The first pass of the plan not approved yet, or null once all of them are. */
export function currentPassOf(state: PassState): EditPass | null {
  return planOf(state).find((p) => state.passes[p].status !== "approved") ?? null;
}

/** The last pass of the run approved from the start (skipped ones do not break the run). */
export function lastApprovedOf(state: PassState): EditPass | null {
  const current = currentPassOf(state);
  const at = current ? EDIT_PASSES.indexOf(current) : EDIT_PASSES.length;
  return EDIT_PASSES.slice(0, at).filter((p) => state.passes[p].status === "approved").at(-1) ?? null;
}

/**
 * Puts a pass in the plan or leaves it out. Leaving it out keeps the montage and its versions (an approval is
 * just no longer needed); bringing it back starts it from scratch, as pending.
 */
function withPlan(state: PassState, changes: Map<EditPass, string | null>): PassState {
  const passes = { ...state.passes };
  const now = new Date().toISOString();
  for (const [pass, reason] of changes) {
    const entry = passes[pass];
    if (reason !== null) {
      if (entry.status !== "skipped" || entry.note !== reason) passes[pass] = { ...emptyEntry(), status: "skipped", note: reason, updatedAt: now };
    } else if (entry.status === "skipped") passes[pass] = { ...emptyEntry(), updatedAt: now };
  }
  return { ...state, planned: true, passes };
}

function describePlan(state: PassState): string {
  const plan = planOf(state);
  const out = EDIT_PASSES.filter((p) => state.passes[p].status === "skipped").map((p) => `${PASS_INFO[p].label.toLowerCase()} («${state.passes[p].note}»)`);
  return `${plan.length ? translate("After this video: {0}.", plan.map((p) => `${PASS_INFO[p].label.toLowerCase()} (${p})`).join(" → ")) : translate("This video doesn't need a pass.")}${out.length ? ` Fuera: ${out.join(", ")}.` : ""}`;
}

/**
 * The agent decides which passes this video needs, from the user's request and what the material already has
 * (already cut, captions burnt in, its own sound…). Every pass goes in `include` or in `skip`, with why.
 */
export function planPasses(projectId: string, include: EditPass[], skip: { pass: EditPass; reason: string }[]): string {
  const reasons = new Map(skip.map((s): [EditPass, string] => [s.pass, s.reason.trim().replace(/\s+/g, " ").slice(0, 160)]));
  const both = include.find((p) => reasons.has(p));
  if (both) throw new Error(translate("{0} ({1}) is both in include and in skip: choose one.", PASS_INFO[both].label, both));
  const missing = EDIT_PASSES.filter((p) => !include.includes(p) && !reasons.has(p));
  if (missing.length) throw new Error(translate("You have to decide {0}: put each pass into include or in skip (with the motive).", missing.join(", ")));
  const state = readPassState(projectId);
  const next = withPlan(state, new Map(EDIT_PASSES.map((p): [EditPass, string | null] => [p, reasons.get(p) ?? null])));
  writePassState(projectId, next);
  const first = currentPassOf(next);
  return translate("{0} The study shows only these. {1}", describePlan(next), first
    ? translate("{0} if the user has already asked for the edition; if you were just asking what to do, finish the shift.", next.passes[first].status === "pending" ? translate("Start with {0} (start_pass {1})", PASS_INFO[first].the, first) : `Sigue por ${PASS_INFO[first].the}`)
    : translate("Tell the user that, if he likes the way he is, he can export."));
}

/** The user puts a pass in this video's plan or leaves it out, from the studio. */
export function setPassIncluded(projectId: string, pass: EditPass, include: boolean): PassState {
  const state = readPassState(projectId);
  const next = withPlan(state, new Map<EditPass, string | null>([[pass, include ? null : translate("You took it off.")]]));
  writePassState(projectId, next);
  return next;
}

export function setPassMode(projectId: string, mode: PassMode): PassState {
  const state = { ...readPassState(projectId), mode };
  writePassState(projectId, state);
  return state;
}

function updatePass(projectId: string, pass: EditPass, patch: Partial<PassEntry>): PassState {
  const state = readPassState(projectId);
  const next = { ...state, passes: { ...state.passes, [pass]: { ...state.passes[pass], ...patch, updatedAt: new Date().toISOString() } } };
  writePassState(projectId, next);
  return next;
}

/**
 * The agent starts (or reopens) a pass of the plan. In «Guiado» every earlier pass of the plan must be approved
 * by the user; in «Rápido» it must at least be finished. Returns what the agent should read.
 */
export function startPass(projectId: string, pass: EditPass): string {
  let state = readPassState(projectId);
  if (!isPlanned(state)) {
    throw new Error(translate("Before you start, decide what this video needs with plan_passes, as requested by the user and what already brings the material (is it already cut?, does it have subtitles?, does its sound?). If you can't deduce it, ask it in a sentence and finish the shift."));
  }
  // Asked for later («ponle subtítulos también»): it joins the plan.
  const joined = state.passes[pass].status === "skipped";
  if (joined) {
    state = withPlan(state, new Map<EditPass, string | null>([[pass, null]]));
    writePassState(projectId, state);
  }
  const earlier = EDIT_PASSES.slice(0, EDIT_PASSES.indexOf(pass)).filter((p) => state.passes[p].status !== "skipped");
  if (state.mode === "guided") {
    const waiting = earlier.find((p) => state.passes[p].status !== "approved");
    if (waiting) {
      const status = state.passes[waiting].status;
      throw new Error(status === "review"
        ? translate("Guided mode: {0} is waiting for user approval. Do not follow: ask him to review and approve it in the study (\"To approve and follow\") or tell you what to change.", PASS_INFO[waiting].the)
        : translate("Guided mode: first goes {0}. Make that pass (start_pass {1}); if the user says it's already well like this, ask him to approve it, and if this video does not need it, take it out of the plan with plan_passes.", PASS_INFO[waiting].the, waiting));
    }
  } else {
    const unfinished = earlier.find((p) => state.passes[p].status === "pending" || state.passes[p].status === "working");
    if (unfinished) throw new Error(translate("Finish first {0} and mark it with mark_pass_ready {1}.", PASS_INFO[unfinished].the, unfinished));
  }
  const reopened = state.passes[pass].status === "approved";
  const later = EDIT_PASSES.slice(EDIT_PASSES.indexOf(pass) + 1).filter((p) => state.passes[p].status !== "pending" && state.passes[p].status !== "skipped");
  const next = invalidateFrom(state, pass, false, translate("To be reviewed after reopening {0}.", PASS_INFO[pass].the));
  next.passes[pass] = { status: "working", note: "", updatedAt: new Date().toISOString(), versionId: null, reviewVersionId: null };
  writePassState(projectId, next);
  return translate("After {0} in progress: {1}. {2} {3} {4} When you finish it, call mark_pass_ready.", PASS_INFO[pass].label.toLowerCase(), PASS_INFO[pass].covers, joined ? translate(" I was out of plan: I added it.") : "", reopened ? translate(" It was approved: when it was finished, it was again marked with mark_pass_ready for the user to reapprove.") : "", later.length ? translate(" {0} remains to be reviewed; the assembly and the previous versions are retained.", passList(later)) : "");
}

/** The agent finished a pass: it waits for the user's review, with a version of what it left. */
export function markPassReady(projectId: string, pass: EditPass, note: string): string {
  const state = readPassState(projectId);
  if (state.passes[pass].status === "pending" || state.passes[pass].status === "skipped") startPass(projectId, pass);
  // The status first, so the version records the pass as ready for review.
  const id = crypto.randomUUID();
  const next = updatePass(projectId, pass, { status: "review", note: note.trim().slice(0, 1000), reviewVersionId: id });
  const draft = saveVersion(projectId, translate("{0} to review", PASS_INFO[pass].label), "review", { pass, id });
  const following = nextPass(pass, skippedIn(next));
  if (next.mode === "guided") {
    return translate("{0} to review (version \"{1}\" saved). Guided mode: FOR HERE. Don't start {2} on this shift. In your message tell the user to give you to play and, if you like, press \"{3}\"; if not, tell you what to change (e.g., \"{4}\").", PASS_INFO[pass].ready, draft.name, following ? PASS_INFO[following].the : translate("nothing more"), following ? "Aprobar y seguir" : "Aprobar", PASS_INFO[pass].example);
  }
  if (following) return translate("{0} to review (version \"{1}\" saved). Quick mode: follow with {2} (start_pass {3}) in this same shift.", PASS_INFO[pass].ready, draft.name, PASS_INFO[following].the, following);
  return translate("All of the plan's past are ready (version \"{0}\" saved). Quick mode: in your message ask the user for a single review of everything: to reproduce and press \"approve everything\" or tell you what to change.", draft.name);
}

export interface ApproveResult {
  /** In order; each one has its «… aprobado» version. */
  approved: EditPass[];
  versions: VersionView[];
  next: EditPass | null;
}

/**
 * The user approves `upTo` and, with it, every earlier pass not approved yet (in «Rápido» they review them
 * together). Each pass gets its «… aprobado» version: the montage as it is now for `upTo` and, for the earlier
 * ones, what each pass left when the agent finished it. Approving an approved pass again saves a new version.
 */
export function approvePasses(projectId: string, upTo: EditPass): ApproveResult {
  const state = readPassState(projectId);
  if (state.passes[upTo].status === "skipped") throw new Error(translate("{0} is not among the steps of this video: there is nothing to approve.", PASS_INFO[upTo].label));
  const until = EDIT_PASSES.indexOf(upTo);
  const pending = EDIT_PASSES.slice(0, until + 1).filter((p) => state.passes[p].status !== "approved" && state.passes[p].status !== "skipped");
  const targets = pending.length ? pending : [upTo];
  const versions = targets.map((pass) => {
    const review = state.passes[pass].reviewVersionId;
    const edit = pass !== upTo && review ? readSnapshot(projectId, review) ?? undefined : undefined;
    // Approved first, so the version records the pass as approved (and as its own approval).
    const id = crypto.randomUUID();
    updatePass(projectId, pass, { status: "approved", versionId: id });
    return saveVersion(projectId, PASS_INFO[pass].approved, "approved", { pass, edit, id });
  });
  return { approved: targets, versions, next: currentPassOf(readPassState(projectId)) };
}

// ---------------------------------------------------------------- undoing an agent turn

/** Where each pass stands, to put back if the agent's turn is undone. */
export type PassSnapshot = PassState;

export function passesSnapshot(projectId: string): PassSnapshot {
  return structuredClone(readPassState(projectId));
}

/**
 * A turn moved the passes in a way worth undoing: it left one for review, approved one with the user's words,
 * or went back to a version. Starting a pass and stopping before anything else is not, on its own.
 */
export function passesMoved(before: PassSnapshot, after: PassSnapshot): boolean {
  const idle = (status: string) => status === "pending" || status === "working";
  return before.mode !== after.mode || before.planned !== after.planned || EDIT_PASSES.some((p) => before.passes[p].status !== after.passes[p].status && !(idle(before.passes[p].status) && idle(after.passes[p].status)));
}

// Only the latest turn can be undone, as with the montage: one file, keyed by the revision the turn left
// (the message stores the same number), replaced whenever a newer turn becomes the one to undo.
const undoFile = (projectId: string) => path.join(folder(projectId), "deshacer.json");

export function rememberPassesForUndo(projectId: string, revisionAfter: number, before: PassSnapshot) {
  // A turn that left the passes alone has nothing of them to undo (and a project that never used them gets no file).
  if (JSON.stringify(before) === JSON.stringify(readPassState(projectId))) fs.rmSync(undoFile(projectId), { force: true });
  else writeJson(undoFile(projectId), { revisionAfter, state: before });
}

/**
 * The turn that left `revisionAfter` is being undone: the passes go back to where they were before it (the
 * mode comes back too; the versions saved meanwhile stay). Returns whether anything changed.
 */
export function restorePassesForUndo(projectId: string, revisionAfter: number | null): boolean {
  const saved = readJson(undoFile(projectId)) as { revisionAfter?: unknown; passes?: unknown; state?: { mode?: unknown; planned?: unknown; passes?: unknown } } | undefined;
  if (revisionAfter === null || saved?.revisionAfter !== revisionAfter) return false;
  const state = readPassState(projectId);
  const passes = passMapSchema.catch(emptyPasses).parse(saved.state?.passes ?? saved.passes);
  const mode = z.enum(PASS_MODES).catch(state.mode).parse(saved.state?.mode);
  const planned = z.boolean().catch(state.planned).parse(saved.state?.planned);
  fs.rmSync(undoFile(projectId), { force: true });
  if (mode === state.mode && planned === state.planned && JSON.stringify(passes) === JSON.stringify(state.passes)) return false;
  writePassState(projectId, { mode, planned, passes });
  return true;
}

// ---------------------------------------------------------------- views

/** `edit`: the montage saved now, when the caller has it already. */
export function passesView(projectId: string, edit?: EditDocument): PassesView {
  const state = readPassState(projectId);
  const versions = listVersions(projectId, edit ?? getProject(projectId)?.edit);
  const planned = isPlanned(state);
  return {
    mode: state.mode,
    planned,
    passes: EDIT_PASSES.map((pass) => ({ pass, status: state.passes[pass].status, note: state.passes[pass].note, updatedAt: state.passes[pass].updatedAt, versionId: state.passes[pass].versionId })),
    current: currentPassOf(state),
    lastApproved: lastApprovedOf(state),
    versions,
    started: versions.length > 0 || planned,
  };
}

/**
 * The passes for the agent's state block: where the project stands and the rules of the mode. Empty for a
 * project with no montage that never used them. `turnStart`: a pass still «en curso» was left unfinished by
 * an earlier turn (the agent was stopped or failed), since this one has not started any yet.
 */
export function describePasses(projectId: string, { turnStart = false } = {}): string {
  const view = passesView(projectId);
  const edit = getProject(projectId)?.edit;
  if (!view.started && !edit?.enabled && !edit?.clips.length) return "";
  const rules = view.mode === "guided"
    ? translate("Guided mode: after mark_pass_ready Stop and ask the user to review and approve or ask for changes; do not start the next pass on the same shift.")
    : translate("Quick mode: frame the plan's past in the same shift (mark_pass_ready of each and start_pass of the following) and ask for a single review at the end.");
  const always = translate("A loose request (change a text, raise music) is made without opening past. Never approve on your own: approve_pass only when the last user message approves it with his words.");
  const saved = view.versions.slice(0, 6).map((v) => `«${v.name}» (${VERSION_KIND_LABELS[v.kind].toLowerCase()}, id ${v.id})`).join(", ");
  const versions = saved ? translate(" Recent versions: {0}.", saved) : "";
  const head = `PASSES (${PASS_MODE_INFO[view.mode].label.toLowerCase()}; skill «passes»):`;
  if (!view.planned) {
    return `${head} PLAN SIN DECIDIR. Las pasadas posibles son corte (cut), subtítulos (captions), gráficos (graphics) y sonido (sound), todas opcionales. Ante un encargo de edición completo, decide primero con plan_passes cuáles necesita ESTE vídeo según lo que pide el usuario y lo que ya trae el material (ya cortado, subtítulos quemados, su propio sonido o música): incluye solo esas. Si no puedes deducirlo y cambia el resultado, pregúntaselo al usuario en una frase (puedes ofrecer las respuestas probables como botones de plan_passes) y termina el turno. ${rules} ${always}${versions}`;
  }
  const plan = view.passes.filter((p) => p.status !== "skipped");
  const steps = plan.map((p, i) => {
    const version = p.versionId ? view.versions.find((v) => v.id === p.versionId) : undefined;
    return `${i + 1} ${PASS_INFO[p.pass].label.toLowerCase()} (${p.pass}): ${PASS_STATUS_LABELS[p.status].toLowerCase()}${version ? ` («${version.name}»)` : ""}`;
  }).join(" → ");
  const out = view.passes.filter((p) => p.status === "skipped").map((p) => `${PASS_INFO[p.pass].label.toLowerCase()} (${p.pass}${p.note ? `: «${p.note}»` : ""})`);
  const current = view.current ? view.passes.find((p) => p.pass === view.current)! : null;
  const where = !plan.length ? translate("This video does not need any pass: it is ready to export.")
    : !current ? translate("All of the plan's past are approved: the video is ready to export.")
    : current.status === "review" ? translate("Current past: {0}, waiting for user approval.", PASS_INFO[current.pass].the)
    : current.status === "working" && turnStart ? translate("Current past: {0}, which was left WITHOUT TERMINAR in a previous shift: take it back from what is in the assembly.", PASS_INFO[current.pass].the)
    : translate("Current past: {0} ({1}).", PASS_INFO[current.pass].the, PASS_STATUS_LABELS[current.status].toLowerCase());
  return translate("{0} plan of this video: {1}. {2} {3} {4} A complete editing order is made with the plan's past, in order: start_pass → changes with the tools → mark_pass_ready. If the user changes his or her idea (\"it's already cut,\" \"put it also subtitles\"), redo the plan with plan_passes. {5} {6}", head, steps || translate("No past"), out.length ? ` Fuera del plan: ${out.join(", ")}.` : "", where, rules, always, versions);
}

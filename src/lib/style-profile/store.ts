import { t as translate } from "@/lib/i18n";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { storageRoot } from "@/lib/storage";
import { getProject, listProjects } from "@/lib/projects";
import { getGlobalAsset, listGlobalAssets, registerGlobalAsset } from "@/lib/global-assets";
import { mergeIntoProfile, profileFromReferences } from "./from-references";
import { blankProfile, ruleProposalSchema, styleProfileSchema, type RuleProposal, type StyleLogo, type StyleProfile, type StyleRule } from "./schema";

/**
 * «Mi estilo» profiles live in one JSON file next to the database, like the app settings: they belong to the
 * user rather than to a project, survive updates and need no migration. The same file says which profile each
 * project uses and keeps the rules the agent proposed until the user accepts or discards them.
 */

const storeSchema = z.object({
  profiles: z.array(z.unknown()).default([]),
  /** projectId -> profileId */
  assignments: z.record(z.string(), z.string()).default({}),
  proposals: z.array(z.unknown()).default([]),
});
interface Store {
  profiles: StyleProfile[];
  assignments: Record<string, string>;
  proposals: RuleProposal[];
}

const file = () => path.join(storageRoot(), "style-profiles.json");
const MAX_PROFILES = 40;
const MAX_PENDING_PER_PROJECT = 6;

/** Reads the store; a profile or proposal that no longer validates is dropped rather than breaking the rest. */
function read(): Store {
  let raw: unknown = {};
  try { raw = JSON.parse(fs.readFileSync(file(), "utf8")); } catch { /* first run, or a hand-broken file */ }
  const parsed = storeSchema.safeParse(raw);
  const data = parsed.success ? parsed.data : storeSchema.parse({});
  const keep = <S extends z.ZodType>(schema: S, items: unknown[]): z.output<S>[] => items.flatMap((item) => { const p = schema.safeParse(item); return p.success ? [p.data as z.output<S>] : []; });
  return { profiles: keep(styleProfileSchema, data.profiles), assignments: data.assignments, proposals: keep(ruleProposalSchema, data.proposals) };
}

function write(store: Store): void {
  fs.mkdirSync(storageRoot(), { recursive: true });
  // Write then rename: a crash mid-write never leaves half a file.
  const tmp = `${file()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, file());
}

const zodSummary = (error: z.ZodError) => error.issues.map((i) => `${i.path.join(" › ")}: ${i.message}`).join("; ");
const newId = () => crypto.randomUUID();

// ---------------------------------------------------------------- profiles

export function listStyleProfiles(): StyleProfile[] {
  return read().profiles.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getStyleProfile(id: string): StyleProfile | undefined {
  return read().profiles.find((p) => p.id === id);
}

/** A name not used by another profile: «Mi estilo», «Mi estilo 2»… */
function freeName(store: Store, wanted: string, except?: string): string {
  const taken = new Set(store.profiles.filter((p) => p.id !== except).map((p) => p.name.toLocaleLowerCase()));
  if (!taken.has(wanted.toLocaleLowerCase())) return wanted;
  for (let n = 2; ; n++) if (!taken.has(`${wanted} ${n}`.toLocaleLowerCase())) return `${wanted} ${n}`;
}

export type SaveResult = { ok: true; profile: StyleProfile } | { ok: false; error: string };

/** Creates or replaces a profile from the editor. Timestamps are the store's; logos must be in the library. */
export function saveStyleProfile(input: unknown): SaveResult {
  const now = Date.now();
  const raw = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const store = read();
  const existing = typeof raw.id === "string" ? store.profiles.find((p) => p.id === raw.id) : undefined;
  if (!existing && store.profiles.length >= MAX_PROFILES) return { ok: false, error: `Puedes tener hasta ${MAX_PROFILES} estilos. Borra alguno que ya no uses.` };
  const parsed = styleProfileSchema.safeParse({ ...raw, id: existing?.id ?? (typeof raw.id === "string" && raw.id ? raw.id : newId()), createdAt: existing?.createdAt ?? now, updatedAt: now });
  if (!parsed.success) return { ok: false, error: translate("Check the style: {0}", zodSummary(parsed.error)) };
  const profile = { ...parsed.data, name: freeName(store, parsed.data.name, parsed.data.id) };
  const missing = profile.logos.find((l) => !getGlobalAsset(l.assetId));
  if (missing) return { ok: false, error: translate("The logo \"{0}\" is no longer in the library. Take it off or choose another one.", missing.name) };
  store.profiles = existing ? store.profiles.map((p) => (p.id === profile.id ? profile : p)) : [...store.profiles, profile];
  write(store);
  return { ok: true, profile };
}

export function createStyleProfile(name = translate("My style")): SaveResult {
  return saveStyleProfile(blankProfile(newId(), name));
}

export function duplicateStyleProfile(id: string): SaveResult {
  const source = getStyleProfile(id);
  if (!source) return { ok: false, error: translate("That style doesn't exist anymore.") };
  return saveStyleProfile({ ...source, id: newId(), name: translate("{0} (copy)", source.name) });
}

/** Deletes a profile; projects that used it are left without one. */
export function deleteStyleProfile(id: string): boolean {
  const store = read();
  if (!store.profiles.some((p) => p.id === id)) return false;
  store.profiles = store.profiles.filter((p) => p.id !== id);
  store.assignments = Object.fromEntries(Object.entries(store.assignments).filter(([, profileId]) => profileId !== id));
  write(store);
  return true;
}

// ---------------------------------------------------------------- projects

export function projectStyleProfile(projectId: string): StyleProfile | undefined {
  const store = read();
  const profileId = store.assignments[projectId];
  return profileId ? store.profiles.find((p) => p.id === profileId) : undefined;
}

/** Which profile a project uses; null: none. */
export function assignStyleProfile(projectId: string, profileId: string | null): { ok: true } | { ok: false; error: string } {
  if (!getProject(projectId)) return { ok: false, error: translate("Project not found.") };
  const store = read();
  if (profileId && !store.profiles.some((p) => p.id === profileId)) return { ok: false, error: translate("That style doesn't exist anymore.") };
  if (profileId) store.assignments[projectId] = profileId;
  else delete store.assignments[projectId];
  write(store);
  return { ok: true };
}

/** The projects that use each profile, by title (only projects that still exist). */
export function profileUsage(): Record<string, { id: string; title: string }[]> {
  const { assignments } = read();
  const out: Record<string, { id: string; title: string }[]> = {};
  for (const p of listProjects()) {
    const profileId = assignments[p.id];
    if (profileId) (out[profileId] ??= []).push({ id: p.id, title: p.title || p.topic || translate("Untitled") });
  }
  return out;
}

// ---------------------------------------------------------------- from references

/** A library entry for a file of the project (registering it if the library has not seen it yet). */
function libraryLogo(projectId: string, file: { name: string; path: string }): StyleLogo {
  const known = listGlobalAssets({ kind: "image" }).find((a) => a.path === file.path);
  const asset = known ?? registerGlobalAsset({ name: file.name, kind: "image", source: "upload", path: file.path, projectId });
  return { assetId: asset.id, name: asset.name, path: asset.path, placement: "" };
}

export type ReferenceDraft =
  | { ok: true; profile: StyleProfile; studied: string[]; unstudied: string[]; base: string | null }
  | { ok: false; error: string; unstudied: string[] };

/**
 * A proposal for the editor, not saved: from the analyses of the project's references, on top of the profile
 * the project uses (`intoCurrent`) or as a new one.
 */
export function draftFromReferences(projectId: string, intoCurrent: boolean): ReferenceDraft {
  const project = getProject(projectId);
  if (!project) return { ok: false, error: translate("Project not found."), unstudied: [] };
  if (!project.edit.references.length) return { ok: false, error: translate("This project has no references. It uploads a video or an image with the style you like in References."), unstudied: [] };
  const store = read();
  const proposal = profileFromReferences(project.edit, newId(), freeName(store, project.title ? translate("{0} style", project.title).slice(0, 80) : translate("My style")), Date.now());
  if (!proposal.studied.length) {
    return { ok: false, error: translate("The assistant hasn't studied your references yet, so there's nothing to summarize."), unstudied: proposal.unstudied };
  }
  proposal.profile.logos = proposal.logoAssets.slice(0, 6).map((l) => libraryLogo(projectId, l));
  const current = intoCurrent ? projectStyleProfile(projectId) : undefined;
  const profile = current ? mergeIntoProfile(current, proposal.profile) : proposal.profile;
  return { ok: true, profile, studied: proposal.studied, unstudied: proposal.unstudied, base: current?.id ?? null };
}

// ---------------------------------------------------------------- learning: rules the agent proposes

export function pendingProposals(projectId: string): RuleProposal[] {
  return read().proposals.filter((p) => p.projectId === projectId).sort((a, b) => a.createdAt - b.createdAt);
}

const sameRule = (a: string, b: string) => a.trim().toLocaleLowerCase().replace(/[.«»"']/g, "") === b.trim().toLocaleLowerCase().replace(/[.«»"']/g, "");

/** Keeps a rule the agent suggests until the user answers. Refuses repeats and rules the profile already has. */
export function proposeRule(projectId: string, text: string, reason: string): RuleProposal {
  const store = read();
  const profile = store.profiles.find((p) => p.id === store.assignments[projectId]);
  if (profile?.rules.some((r) => sameRule(r.text, text))) throw new Error(translate("\"{0}\" already has that rule: there is no need to propose it.", profile.name));
  const pending = store.proposals.filter((p) => p.projectId === projectId);
  const repeated = pending.find((p) => sameRule(p.text, text));
  if (repeated) return repeated;
  if (pending.length >= MAX_PENDING_PER_PROJECT) throw new Error(translate("There are already several proposals waiting for user response: don't propose any more until you answer them."));
  const proposal = ruleProposalSchema.parse({ id: newId(), projectId, text, reason, createdAt: Date.now() });
  store.proposals.push(proposal);
  write(store);
  return proposal;
}

export function discardProposal(projectId: string, proposalId: string): boolean {
  const store = read();
  const before = store.proposals.length;
  store.proposals = store.proposals.filter((p) => !(p.id === proposalId && p.projectId === projectId));
  if (store.proposals.length === before) return false;
  write(store);
  return true;
}

/**
 * The user accepted a proposed rule: it joins the project's profile, or `targetId`, or a new «Mi estilo» that
 * the project then uses. The user may have reworded it first.
 */
export function acceptProposal(projectId: string, proposalId: string, options: { targetId?: string | null; text?: string } = {}): SaveResult {
  const store = read();
  const proposal = store.proposals.find((p) => p.id === proposalId && p.projectId === projectId);
  if (!proposal) return { ok: false, error: translate("That proposal is no longer pending.") };
  const text = (options.text ?? proposal.text).trim();
  if (text.length < 3) return { ok: false, error: translate("Write the rule.") };
  const project = getProject(projectId);
  // undefined: the project's profile; null: a new one.
  const targetId = options.targetId === undefined ? store.assignments[projectId] ?? null : options.targetId;
  const target = targetId ? store.profiles.find((p) => p.id === targetId) : undefined;
  if (targetId && !target) return { ok: false, error: translate("That style doesn't exist anymore.") };
  const rule: StyleRule = { id: newId(), text, source: "learned", projectId, projectTitle: (project?.title || project?.topic || "").slice(0, 160) || undefined, createdAt: Date.now() };
  const base = target ?? blankProfile(newId(), translate("My style"));
  const saved = saveStyleProfile({ ...base, rules: base.rules.some((r) => sameRule(r.text, text)) ? base.rules : [...base.rules, rule] });
  if (!saved.ok) return saved;
  const after = read();
  after.proposals = after.proposals.filter((p) => p.id !== proposalId);
  if (!after.assignments[projectId] && project) after.assignments[projectId] = saved.profile.id;
  write(after);
  return saved;
}

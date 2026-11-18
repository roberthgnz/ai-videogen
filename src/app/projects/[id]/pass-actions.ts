"use server";

import { t as translate } from "@/lib/i18n";
import { refresh } from "next/cache";
import { z } from "zod";
import { isAgentBusy } from "@/lib/agent/run";
import { approveFromStudio, type StudioApproval } from "@/lib/agent/pass-approval";
import { getProject } from "@/lib/projects";
import { deleteVersion, renameVersion, restoreVersion, saveVersion, setPassIncluded, setPassMode } from "@/lib/editing/passes";
import { EDIT_PASSES, PASS_INFO, PASS_MODES } from "@/lib/editing/passes-shared";
import type { EditDocument } from "@/lib/editing/schema";

// Local single-user app (bound to 127.0.0.1): no auth checks by design.

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

function guard(projectId: unknown): string | null {
  if (typeof projectId !== "string" || !getProject(projectId)) return translate("Project not found.");
  if (isAgentBusy(projectId)) return translate("Wait till the agent's done.");
  return null;
}

const failure = (e: unknown, fallback: string) => ({ ok: false as const, error: e instanceof Error ? e.message : fallback });

/** «Guiado» or «Rápido», per project. */
export async function setPassModeAction(projectId: string, mode: unknown): Promise<Result> {
  const problem = guard(projectId);
  if (problem) return { ok: false, error: problem };
  const parsed = z.enum(PASS_MODES).safeParse(mode);
  if (!parsed.success) return { ok: false, error: translate("Invalid mode.") };
  try {
    setPassMode(projectId, parsed.data);
    refresh();
    return { ok: true };
  } catch (e) { return failure(e, translate("You couldn't change the way.")); }
}

/** The user puts a step in this video's plan or leaves it out (already cut, captions burnt in…). */
export async function setPassIncludedAction(projectId: string, pass: unknown, include: unknown): Promise<Result> {
  const problem = guard(projectId);
  if (problem) return { ok: false, error: problem };
  const parsed = z.enum(EDIT_PASSES).safeParse(pass);
  if (!parsed.success || typeof include !== "boolean") return { ok: false, error: translate("Invalid pass.") };
  try {
    setPassIncluded(projectId, parsed.data, include);
    refresh();
    return { ok: true };
  } catch (e) { return failure(e, translate("It could not be changed {0}.", PASS_INFO[parsed.data].the)); }
}

/**
 * The user approves a pass (and the earlier ones still waiting): each one gets its «… aprobado» version, and
 * the approval goes in the chat, undoable. `follow`: the agent goes on with the next pass.
 */
export async function approvePassAction(projectId: string, pass: unknown, follow = false): Promise<Result<StudioApproval>> {
  const problem = guard(projectId);
  if (problem) return { ok: false, error: problem };
  const parsed = z.enum(EDIT_PASSES).safeParse(pass);
  if (!parsed.success) return { ok: false, error: translate("Not valid.") };
  try {
    const result = approveFromStudio(projectId, parsed.data, follow === true);
    refresh();
    return { ok: true, ...result };
  } catch (e) { return failure(e, translate("It could not be approved {0}.", PASS_INFO[parsed.data].the)); }
}

/** Saves the montage as it is now (the studio saves pending edits first) under a name of the user's. */
export async function saveVersionAction(projectId: string, name: unknown): Promise<Result<{ name: string }>> {
  const problem = guard(projectId);
  if (problem) return { ok: false, error: problem };
  const parsed = z.string().trim().min(1, translate("Put a name on the version.")).max(80, translate("The name is too long.")).safeParse(name);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? translate("Invalid name.") };
  try {
    const version = saveVersion(projectId, parsed.data, "manual");
    refresh();
    return { ok: true, name: version.name };
  } catch (e) { return failure(e, translate("You couldn't save the version.")); }
}

const versionId = z.string().regex(/^[a-f0-9-]{36}$/);
const versionName = z.string().trim().min(1, "Put a name on the version.").max(80, "The name is too long.");

export async function renameVersionAction(projectId: string, id: unknown, name: unknown): Promise<Result<{ name: string }>> {
  const problem = guard(projectId);
  if (problem) return { ok: false, error: problem };
  if (!versionId.safeParse(id).success) return { ok: false, error: translate("Invalid version.") };
  const parsed = versionName.safeParse(name);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? translate("Invalid name.") };
  try {
    const version = renameVersion(projectId, id as string, parsed.data);
    refresh();
    return { ok: true, name: version.name };
  } catch (e) { return failure(e, translate("You couldn't change the name.")); }
}

/** Removes a version for good (the studio asks first). The montage on screen does not change. */
export async function deleteVersionAction(projectId: string, id: unknown): Promise<Result<{ name: string }>> {
  const problem = guard(projectId);
  if (problem) return { ok: false, error: problem };
  if (!versionId.safeParse(id).success) return { ok: false, error: translate("Invalid version.") };
  try {
    const version = deleteVersion(projectId, id as string);
    refresh();
    return { ok: true, name: version.name };
  } catch (e) { return failure(e, translate("The version could not be deleted.")); }
}

/** Goes back to a version; what there was before is kept as a version too. */
export async function restoreVersionAction(projectId: string, versionId: unknown): Promise<Result<{ edit: EditDocument; name: string; backup: string | null; dropped: number }>> {
  const problem = guard(projectId);
  if (problem) return { ok: false, error: problem };
  if (typeof versionId !== "string" || !/^[a-f0-9-]{36}$/.test(versionId)) return { ok: false, error: translate("Invalid version.") };
  try {
    const result = restoreVersion(projectId, versionId);
    refresh();
    return { ok: true, edit: result.edit, name: result.version.name, backup: result.backup?.name ?? null, dropped: result.dropped };
  } catch (e) { return failure(e, translate("You couldn't go back to that version.")); }
}

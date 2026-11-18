"use server";

import { t as translate } from "@/lib/i18n";
import { listGlobalAssets } from "@/lib/global-assets";
import {
  acceptProposal,
  assignStyleProfile,
  createStyleProfile,
  deleteStyleProfile,
  discardProposal,
  draftFromReferences,
  duplicateStyleProfile,
  listStyleProfiles,
  pendingProposals,
  projectStyleProfile,
  saveStyleProfile,
  type ReferenceDraft,
  type SaveResult,
} from "@/lib/style-profile/store";
import type { RuleProposal, StyleProfile } from "@/lib/style-profile/schema";

// Local single-user app (bound to 127.0.0.1): no auth checks by design.

type Result = { ok: true } | { ok: false; error: string };
const failed = (error: unknown, fallback: string) => ({ ok: false as const, error: error instanceof Error ? error.message : fallback });

/** Saves a profile from the editor; with `assignTo`, that project uses it from now on. */
export async function saveStyleProfileAction(input: unknown, assignTo?: string): Promise<SaveResult> {
  try {
    const saved = saveStyleProfile(input);
    if (saved.ok && assignTo) {
      const assigned = assignStyleProfile(assignTo, saved.profile.id);
      if (!assigned.ok) return assigned;
    }
    return saved;
  } catch (error) {
    return failed(error, translate("You couldn't keep the style."));
  }
}

export async function createStyleProfileAction(name?: string): Promise<SaveResult> {
  try { return createStyleProfile(name?.trim() || translate("My style")); } catch (error) { return failed(error, translate("You couldn't create the style.")); }
}

export async function duplicateStyleProfileAction(id: string): Promise<SaveResult> {
  try { return duplicateStyleProfile(id); } catch (error) { return failed(error, translate("You couldn't double the style.")); }
}

export async function deleteStyleProfileAction(id: string): Promise<Result> {
  try { return deleteStyleProfile(id) ? { ok: true } : { ok: false, error: translate("That style doesn't exist anymore.") }; } catch (error) { return failed(error, translate("You couldn't erase the style.")); }
}

/** What the studio's «Mi estilo» card and the chat need: every profile, the project's, and the rules waiting for an answer. */
export async function projectStyleAction(projectId: string): Promise<{ profiles: StyleProfile[]; assignedId: string | null; proposals: RuleProposal[] }> {
  return { profiles: listStyleProfiles(), assignedId: projectStyleProfile(projectId)?.id ?? null, proposals: pendingProposals(projectId) };
}

export async function assignStyleProfileAction(projectId: string, profileId: string | null): Promise<Result> {
  try { return assignStyleProfile(projectId, profileId); } catch (error) { return failed(error, translate("The style of the project could not be changed.")); }
}

/** A proposal from the project's studied references, for the user to review before saving. */
export async function draftStyleFromReferencesAction(projectId: string, intoCurrent: boolean): Promise<ReferenceDraft> {
  try { return draftFromReferences(projectId, intoCurrent); } catch (error) { return { ...failed(error, translate("The proposal could not be prepared.")), unstudied: [] }; }
}

export async function acceptStyleRuleAction(projectId: string, proposalId: string, options: { targetId?: string | null; text?: string }): Promise<SaveResult> {
  try { return acceptProposal(projectId, proposalId, options); } catch (error) { return failed(error, translate("The rule could not be added.")); }
}

export async function discardStyleRuleAction(projectId: string, proposalId: string): Promise<Result> {
  try { return discardProposal(projectId, proposalId) ? { ok: true } : { ok: false, error: translate("That proposal is no longer pending.") }; } catch (error) { return failed(error, translate("It couldn't be ruled out.")); }
}

/** Pictures in the global library, to pick a logo from. */
export async function libraryImagesAction(): Promise<{ id: string; name: string; path: string; width: number; height: number }[]> {
  return listGlobalAssets({ kind: "image" }).map((a) => ({ id: a.id, name: a.name, path: a.path, width: a.width, height: a.height }));
}

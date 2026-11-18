"use server";

import { t as translate } from "@/lib/i18n";
import { refresh } from "next/cache";
import { z } from "zod";
import { cancelAgentTurn, isAgentBusy, runSuggestion, startAgentTurn, undoAgentTurn, type UndoResult } from "@/lib/agent/run";
import { clearAgentMessages, getProject } from "@/lib/projects";
import { resolveApproval } from "@/lib/agent/approvals";
import { resetAgentSession } from "@/lib/agent/cli";

// Local single-user app (bound to 127.0.0.1): no auth checks by design.

export type AgentActionResult = { ok: true } | { ok: false; error: string };

/**
 * Starts a turn of the agent in the background; the page polls its progress. `context` (the studio's mode,
 * the selected element) goes to the model only: the conversation shows what the user wrote.
 */
export async function sendAgentMessageAction(projectId: string, text: string, context?: string): Promise<AgentActionResult> {
  if (typeof text !== "string" || text.length > 4000) return { ok: false, error: translate("The message is too long.") };
  if (context !== undefined && (typeof context !== "string" || context.length > 300)) return { ok: false, error: translate("Invalid context.") };
  const result = startAgentTurn(projectId, text, context ? { origin: context } : {});
  refresh();
  return result;
}

/** «Detener»: stops the agent's turn; what it already changed stays and can be undone. */
export async function cancelAgentTurnAction(projectId: string): Promise<AgentActionResult> {
  if (typeof projectId !== "string") return { ok: false, error: translate("Invalid project.") };
  const result = cancelAgentTurn(projectId);
  refresh();
  return result;
}

const suggestionSchema = z.object({
  label: z.string().max(80),
  tool: z.string().max(60).optional(),
  input: z.record(z.string(), z.unknown()).optional(),
  href: z.string().max(200).optional(),
});

/** Runs one of the buttons the agent proposed, directly. */
export async function runSuggestionAction(projectId: string, suggestion: unknown): Promise<AgentActionResult> {
  const parsed = suggestionSchema.safeParse(suggestion);
  if (!parsed.success) return { ok: false, error: translate("Invalid action.") };
  const result = await runSuggestion(projectId, parsed.data);
  refresh();
  return result;
}

/** Puts the montage back as it was before an assistant reply. `force` also drops edits made after it. */
export async function undoAgentTurnAction(projectId: string, messageId: string, force = false): Promise<UndoResult> {
  if (typeof messageId !== "string" || messageId.length > 100) return { ok: false, error: translate("Invalid action.") };
  const result = undoAgentTurn(projectId, messageId, force === true);
  refresh();
  return result;
}

export async function clearChatAction(projectId: string): Promise<AgentActionResult> {
  if (!getProject(projectId)) return { ok: false, error: translate("Project not found.") };
  if (isAgentBusy(projectId)) return { ok: false, error: "Espera a que termine lo que estoy haciendo." };
  clearAgentMessages(projectId);
  // Claude Code / Codex keep their own conversation: a cleared chat starts a new one.
  resetAgentSession(projectId);
  refresh();
  return { ok: true };
}

/** The user's answer to a permission question from Claude Code or Codex. `wholeTurn`: yes to the rest of this turn. */
export async function answerApprovalAction(projectId: string, approvalId: string, allowed: boolean, wholeTurn = false): Promise<AgentActionResult> {
  if (typeof approvalId !== "string" || approvalId.length > 100) return { ok: false, error: translate("Request invalid.") };
  const found = resolveApproval(projectId, approvalId, allowed === true, wholeTurn === true);
  refresh();
  return found ? { ok: true } : { ok: false, error: translate("That request is no longer pending.") };
}

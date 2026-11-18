import { t as translate } from "@/lib/i18n";
import { addAgentMessage } from "@/lib/projects";
import { approvePasses } from "@/lib/editing/passes";
import { PASS_INFO, type EditPass } from "@/lib/editing/passes-shared";
import { snapshotEdit, startAgentTurn, undoRecord } from "./run";

export interface StudioApproval {
  approved: EditPass[];
  next: EditPass | null;
  /** The agent went on with the next pass: «Deshacer» on its reply also takes back the approval. */
  continued: boolean;
  /** The chat message whose «Deshacer» takes back this approval, when the agent did not go on. */
  undoId: string | null;
  /** The approval is saved but the agent could not go on (it was busy, for one). */
  warning: string | null;
}

const passList = (passes: EditPass[]) => passes.map((p) => PASS_INFO[p].the).join(" y ");

/**
 * The user approves a pass from the studio. It goes in the conversation like any step they take, so the
 * agent knows and «Deshacer» takes it back. With `follow`, the agent goes on with the next pass in a turn
 * that starts from before the approval: one «Deshacer» on its reply takes back both.
 */
export function approveFromStudio(projectId: string, pass: EditPass, follow: boolean): StudioApproval {
  const before = snapshotEdit(projectId);
  const result = approvePasses(projectId, pass);
  const what = passList(result.approved);
  let warning: string | null = null;
  if (follow && result.next) {
    const turn = startAgentTurn(projectId, `He aprobado ${what}. Sigue con ${PASS_INFO[result.next].the}.`, {
      origin: translate("Editable assembly · edition by past"),
      undoFrom: before,
    });
    if (turn.ok) return { approved: result.approved, next: result.next, continued: true, undoId: null, warning: null };
    warning = translate("The approval is kept, but the agent was unable to follow: {0}", turn.error);
  }
  addAgentMessage(projectId, { role: "user", text: `Aprobar ${what}` });
  const saved = result.versions.map((v) => `«${v.name}»`).join(", ");
  const reply = addAgentMessage(projectId, {
    role: "assistant",
    text: translate("Approved: I have saved {0}. {1} If not that, click \"Undo.\"", saved, result.next ? `Siguiente: ${PASS_INFO[result.next].the}.` : translate("All the steps of this video are approved: you can export it now.")),
    undo: undoRecord(projectId, before),
  });
  return { approved: result.approved, next: result.next, continued: false, undoId: reply.editBefore ? reply.id : null, warning };
}

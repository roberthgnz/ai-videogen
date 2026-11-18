import { t as translate } from "@/lib/i18n";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { getProject } from "@/lib/projects";
import { editDocumentSchema, type EditDocument } from "./schema";
import { z } from "zod";
import { invalidatePassesForEdit } from "./pass-state";

export const editDetailsSchema = z.object({ title: z.string().trim().min(1).max(80), format: z.enum(["vertical", "horizontal"]) });
export type EditDetails = z.infer<typeof editDetailsSchema>;

/** Asset paths and metadata are server-owned; client edits can only use registered assets. */
export function saveEditDocument(projectId: string, raw: unknown, serverAssets = false, details?: EditDetails): EditDocument {
  return getDb().transaction(() => {
    const p = getProject(projectId);
    if (!p) throw new Error(translate("Project not found."));
    const next = editDocumentSchema.parse(raw);
    if (next.revision !== p.edit.revision) throw new Error(translate("The project has changed. Recharge before saving to keep the agent changes."));
    if (!serverAssets) next.assets = p.edit.assets;
    // Recheck references and trims against authoritative metadata.
    const checked = editDocumentSchema.parse(next);
    const parsedDetails = details ? editDetailsSchema.parse(details) : null;
    // The studio saves before every message to the agent. When nothing changed the revision stays, so the
    // reply's «Deshacer» does not warn about edits the user never made.
    // A stored document that no longer passes the schema (older data) simply counts as changed and is saved.
    const current = editDocumentSchema.safeParse(p.edit);
    const sameDetails = !parsedDetails || (parsedDetails.title === p.title && parsedDetails.format === p.format);
    if (current.success && sameDetails && JSON.stringify(checked) === JSON.stringify(current.data)) return current.data;
    checked.revision += 1;
    const metadata = parsedDetails ?? {};
    getDb().update(projects).set({ edit: checked, ...metadata }).where(eq(projects.id, projectId)).run();
    invalidatePassesForEdit(projectId, p.edit, checked, !!parsedDetails && parsedDetails.format !== p.format);
    return checked;
  });
}

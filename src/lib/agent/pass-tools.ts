import { t as translate, getLocale } from "@/lib/i18n";
import { z } from "zod";
import { listAgentMessages } from "@/lib/projects";
import {
  approvePasses,
  deleteVersion,
  describePasses,
  findVersion,
  listVersions,
  markPassReady,
  planPasses,
  renameVersion,
  restoreVersion,
  saveVersion,
  startPass,
} from "@/lib/editing/passes";
import { EDIT_PASSES, PASS_INFO, passList, VERSION_KIND_LABELS } from "@/lib/editing/passes-shared";
import type { AgentTool } from "./tools";

/**
 * The agent's side of editing in passes (see agent-skills/passes): where the project stands, starting and
 * finishing a pass, the versions, and approving only with the user's own words. The studio shows the same
 * state and its «Aprobar» buttons; the rules of each mode are in the state block (describePasses).
 */

function tool<S extends z.ZodObject>(def: AgentTool<S>): AgentTool<S> {
  return def;
}

const passSchema = z.enum(EDIT_PASSES).describe("cut = cut (planes, order and duration) · captions = subtitles · graphics = titles, signs, transitions and movements · sound = music, voice and volume");

/** Lowercase, without accents or punctuation: «¡Me GUSTA, sigue!» and «me gusta sigue» are the same words. */
const plain = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** What the user wrote last: this turn's message (or the label of the button they pressed). */
function latestUserWords(projectId: string): string {
  return listAgentMessages(projectId, 8).filter((m) => m.role === "user").at(-1)?.text ?? "";
}

const getPass = tool({
  name: "get_pass",
  description: "See the project's past edition: the mode (guided or fast), what this video needs and what is left out, what was the last approved and the saved versions. Use it when you take up a project or if you doubt what it is.",
  schema: z.object({}),
  label: () => translate("Consult the current past"),
  run: (_input, ctx) => {
    const versions = listVersions(ctx.projectId);
    const list = versions.slice(0, 15).map((v) => `- «${v.name}» · ${VERSION_KIND_LABELS[v.kind].toLowerCase()} · ${v.summary} · ${new Date(v.createdAt).toLocaleString(getLocale())} · id ${v.id}`).join("\n");
    return translate("{0}\n\nSaving versions (from the latest to the oldest):\n{1}", describePasses(ctx.projectId) || translate("This project has not yet been assembled or passed."), list || translate("- (none)"));
  },
});

const planPassesTool = tool({
  name: "plan_passes",
  description: "Decide qué pasadas necesita ESTE vídeo antes de empezar un encargo de edición completo, o rehaz el plan si el usuario cambia de idea. Todas son opcionales: pon en include las que hay que hacer y en skip las que sobran, con el motivo. Decide por lo que pide el usuario y por lo que ya trae el material: si ya viene cortado, sin corte; si ya lleva subtítulos quemados o no los quiere, sin subtítulos; si no pide títulos, rótulos ni efectos y la referencia no los tiene, sin gráficos; si su sonido vale y no pide música ni voz, sin sonido. Si no puedes deducirlo y cambia el resultado, pregunta antes al usuario en una frase. El estudio solo muestra las pasadas incluidas.",
  schema: z.object({
    include: z.array(z.enum(EDIT_PASSES)).max(4).describe("The passes to be done. They are always made in the order cut → subtitles → graphics → sound"),
    skip: z.array(z.object({
      pass: z.enum(EDIT_PASSES),
      reason: z.string().trim().min(4).max(160).describe("Explain in the studio language why the user can skip this pass, for example \"The video already has subtitles.\""),
    })).max(4).describe("The past that this video does not need, each with its motive; empty if it does all"),
  }),
  label: (i) => i.include.length ? translate("Steps of this video: {0}", passList(EDIT_PASSES.filter((p) => i.include.includes(p)), "label")) : translate("No editing steps"),
  run: (input, ctx) => planPasses(ctx.projectId, input.include, input.skip),
});

const startPassTool = tool({
  name: "start_pass",
  description: "Start (or reopen to change) a pass of the plan of this video before playing the assembly: cut, captions, graphics or sound, in that order. You need a plan (plan_passes). A pass that was outside the plan enters it. In guided mode you refuse if a previous pass of the scheme is not approved by the user: then stop and ask him to review it. No need for loose requests.",
  schema: z.object({ pass: passSchema }),
  label: (i) => translate("Start the past of {0}", PASS_INFO[i.pass].label.toLowerCase()),
  run: (input, ctx) => startPass(ctx.projectId, input.pass),
});

const markPassReadyTool = tool({
  name: "mark_pass_ready",
  description: "Mark a pass as a list for the user to review and save a version with what is left. Call it at the end of each pass, after reviewing the result (review_edit). DO NOT approve it: the approval is from the user. In guided mode, after calling it ends the turn and wait; quickly, follow the next pass.",
  schema: z.object({
    pass: passSchema,
    note: z.string().min(8).max(600).describe("In the studio language, tell the user what changed in this pass and what to review. For example, \"I kept nine shots in recording order and removed the pauses. Check the opening hook.\""),
  }),
  label: (i) => translate("{0} to review", PASS_INFO[i.pass].ready),
  run: (input, ctx) => markPassReady(ctx.projectId, input.pass, input.note),
});

const approvePassTool = tool({
  name: "approve_pass",
  description: "It records that the USER approves a pass (and the previous ones without approval) and saves its version... \"approved.\" Only when its last message approves it with its words (\"I like, follow,\" \"the cut is fine\"): copy those words in userWords. Never on your own, or to move faster, or if your message asks for changes. If you doubt, ask him or tell him to press \"approve\" in the study.",
  schema: z.object({
    pass: passSchema,
    userWords: z.string().min(2).max(200).describe("The exact words of the last user message with which he approves"),
  }),
  label: (i) => `Aprobar ${PASS_INFO[i.pass].the} («${i.userWords.slice(0, 40)}»)`,
  run: (input, ctx) => {
    const said = plain(latestUserWords(ctx.projectId));
    const quote = plain(input.userWords);
    if (quote.length < 2 || !said.includes(quote)) {
      throw new Error(translate("Those words are not in the last user message. Only the user approves: ask him to confirm it or to press \"approve\" in the study."));
    }
    const result = approvePasses(ctx.projectId, input.pass);
    const names = result.versions.map((v) => `«${v.name}»`).join(", ");
    return translate("User-approved: {0}. Saving version: {1}. {2}", result.approved.map((p) => PASS_INFO[p].the).join(", "), names, result.next ? translate("Next pass: {0} ({1}).", PASS_INFO[result.next].the, result.next) : translate("All of the plan's past are approved: the video is ready to export when the user wants."));
  },
});

const saveVersionTool = tool({
  name: "save_version",
  description: "Save the assembly as it is now as a name version, to be able to return to it. Use it when the user requests it (\"save this version as...\") or before a big change you may want to undo. Do not approve any pass.",
  schema: z.object({ name: z.string().trim().min(1).max(80).describe("Short and clear name, e.g. \"Short version for TikTok\"") }),
  label: (i) => translate("Save the \"{0}\" version", i.name),
  run: (input, ctx) => {
    const version = saveVersion(ctx.projectId, input.name, "agent");
    return translate("\"{0}\" version saved ({1}, id {2}). The user sees it in Versions and can return to it whenever he wants.", version.name, version.summary, version.id);
  },
});

const listVersionsTool = tool({
  name: "list_versions",
  description: "List the saved versions of the assembly (approved, saved by the user or by you, to review and automatic copies), from the latest to the oldest, with your id.",
  schema: z.object({}),
  label: () => translate("View the saved versions"),
  run: (_input, ctx) => {
    const versions = listVersions(ctx.projectId);
    if (!versions.length) return translate("There are still no saved versions.");
    return versions.map((v) => `- «${v.name}» · ${VERSION_KIND_LABELS[v.kind].toLowerCase()}${v.pass ? translate(" · past {0}", v.pass) : ""} · ${v.summary} · ${new Date(v.createdAt).toLocaleString(getLocale())} · id ${v.id}`).join("\n");
  },
});

const restoreVersionTool = tool({
  name: "restore_version",
  description: "It returns to a saved version: its assembly (clips, texts, duration, background and resources) and the point of the past in which it was. Before it saves what is now as an automatic copy, so nothing is lost. Project files and references do not change. Only when the user requests it.",
  schema: z.object({ version: z.string().min(1).max(120).describe("Id of the version (of get_pass or list_versions) or its exact name, e.g. \"approved cut\"") }),
  label: (i) => translate("Back to version {0}", /^[a-f0-9-]{36}$/.test(i.version) ? "guardada" : `«${i.version}»`),
  run: (input, ctx) => {
    const found = findVersion(ctx.projectId, input.version);
    if (!found) throw new Error(translate("I can't find that version. Use list_versions to see their names and ids."));
    const result = restoreVersion(ctx.projectId, found.id);
    return translate("Reported to \"{0} '({1}). {2} {3}\n{4}", result.version.name, result.version.summary, result.backup ? translate(" What was before is saved as \"{0}.\"", result.backup.name) : "", result.dropped ? translate(" {0} that are no longer in the project and has {1} been left out.", result.dropped === 1 ? translate("A clip used a file") : translate("{0} clips used files", result.dropped), result.dropped === 1 ? "" : "n") : "", describePasses(ctx.projectId));
  },
});

const versionRef = z.string().min(1).max(120).describe("Id of the version (of get_pass or list_versions) or its exact name");

function versionOf(projectId: string, ref: string) {
  const found = findVersion(projectId, ref);
  if (!found) throw new Error(translate("I can't find that version. Use list_versions to see their names and ids."));
  return found;
}

const renameVersionTool = tool({
  name: "rename_version",
  description: "Change the name of a saved version when the user requests it (\"call this version...\"). It does not change the assembly.",
  schema: z.object({ version: versionRef, name: z.string().trim().min(1).max(80).describe("New, short and clear name") }),
  label: (i) => translate("Rename version to \"{0}\"", i.name),
  run: (input, ctx) => {
    const before = versionOf(ctx.projectId, input.version);
    const version = renameVersion(ctx.projectId, before.id, input.name);
    return translate("Version \"{0}\" renamed \"{1}.\"", before.name, version.name);
  },
});

const deleteVersionTool = tool({
  name: "delete_version",
  description: "It always erases a saved version. Only when the last user message asks for it with its words (\"delete the short version\"): copy them in userWords. Never to make room or on your own. It does not change the current assembly, and a approved pass remains approved even if its version is deleted.",
  schema: z.object({
    version: versionRef,
    userWords: z.string().min(2).max(200).describe("The exact words of the last user message with which you ask to delete it"),
  }),
  label: (i) => translate("Delete version {0}", /^[a-f0-9-]{36}$/.test(i.version) ? "guardada" : `«${i.version}»`),
  run: (input, ctx) => {
    const quote = plain(input.userWords);
    if (quote.length < 2 || !plain(latestUserWords(ctx.projectId)).includes(quote)) {
      throw new Error(translate("Those words are not in the last user message. To delete is for ever: only if he requests it. You can also delete it in Versions."));
    }
    const version = deleteVersion(ctx.projectId, versionOf(ctx.projectId, input.version).id);
    return translate("\"{0}\" version deleted. The current assembly does not change.", version.name);
  },
});

export const PASS_TOOLS = [getPass, planPassesTool, startPassTool, markPassReadyTool, approvePassTool, saveVersionTool, listVersionsTool, restoreVersionTool, renameVersionTool, deleteVersionTool] as unknown as AgentTool[];

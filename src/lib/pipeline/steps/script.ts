import { t as translate } from "@/lib/i18n";
import { defaultVoiceId, getProject, replaceScript, setScriptStatus, voicePace } from "@/lib/projects";
import { errorMessage } from "../errors";
import { getScriptGenerator, type ScriptGenerator } from "../script";

export type StepResult = { ok: true } | { ok: false; error: string };

/**
 * Script step for one project: reads its settings, generates the script and
 * replaces its scenes. Status and the real error are persisted so the UI can
 * show them and offer a retry.
 */
export async function runScriptStep(
  projectId: string,
  generator: ScriptGenerator = getScriptGenerator(),
): Promise<StepResult> {
  const project = getProject(projectId);
  if (!project) return { ok: false, error: translate("Project not found.") };

  setScriptStatus(projectId, "running");
  try {
    const draft = await generator.generate({
      topic: project.topic,
      targetDurationSec: project.targetDurationSec,
      tone: project.tone,
      format: project.format,
      wordsPerSecond: voicePace(project.voiceId ?? defaultVoiceId()) ?? undefined,
      direction: project.edit.direction,
      references: project.edit.references.map((r) => ({
        title: r.title, roles: r.roles, content: r.content, analysis: r.analysis,
        transcript: project.edit.assets.find((a) => a.id === r.assetId)?.context || undefined,
      })),
    });
    replaceScript(projectId, draft);
    return { ok: true };
  } catch (error) {
    const message = errorMessage(error);
    console.error(`[script] project ${projectId}:`, error);
    setScriptStatus(projectId, "error", message);
    return { ok: false, error: message };
  }
}

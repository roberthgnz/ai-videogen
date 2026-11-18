import { t as translate } from "@/lib/i18n";
import { io } from "next/cache";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { defaultSuggestions, isAgentBusy, liveAgentActions, liveAgentStep, liveAgentText } from "@/lib/agent/run";
import { pendingApprovals } from "@/lib/agent/approvals";
import { getProject, listAgentMessages } from "@/lib/projects";
import { AGENT_PROVIDER_INFO, getAppSettings } from "@/lib/app-settings";
import { allProviderStatuses, publicStatus } from "@/lib/agent/cli";
import { env } from "@/lib/env";
import { projectView } from "./data";
import { Studio } from "./studio";

export default function ProjectPage({ params }: PageProps<"/projects/[id]">) {
  return (
    <Suspense fallback={<p className="grid h-dvh place-items-center text-muted">{translate("Loading…")}</p>}>
      <StudioLoader params={params} />
    </Suspense>
  );
}

async function StudioLoader({ params }: { params: PageProps<"/projects/[id]">["params"] }) {
  const { id } = await params;
  await io();
  const project = getProject(id);
  if (!project) notFound();

  const messages = listAgentMessages(id).map((m) => ({
    id: m.id,
    role: m.role,
    text: m.text,
    actions: m.actions,
    suggestions: m.suggestions,
    // Only the latest reply that changed the montage can be undone; `edited`: the user changed it after that reply.
    undo: m.editBefore ? { edited: m.editRevisionAfter !== project.edit.revision } : null,
  }));
  const last = messages.at(-1);
  // The agent's own proposals if it spoke last; otherwise what the project's state says comes next.
  // «Cancelar el render» is only offered while a render runs: once it ends, the state's next steps replace it.
  const next = defaultSuggestions(id);
  const rendering = next.some((s) => s.tool === "cancel_render");
  const proposed = last?.role === "assistant" ? last.suggestions.filter((s) => s.tool !== "cancel_render" || rendering) : [];
  const suggestions = proposed.length > 0 ? proposed : next;
  // Changes whenever the project or any scene changes on the server: the studio then takes the new state.
  const version = Math.max(project.updatedAt.getTime(), ...project.scenes.map((s) => s.updatedAt.getTime()));

  const settings = getAppSettings();
  const statuses = (await allProviderStatuses()).map(publicStatus);
  const provider = {
    id: settings.agentProvider,
    label: AGENT_PROVIDER_INFO[settings.agentProvider].label,
    problem: statuses.find((s) => s.id === settings.agentProvider)?.problem ?? null,
    statuses,
  };
  return (
    <Studio
      project={projectView(project)}
      version={version}
      agent={{ messages, busy: isAgentBusy(id), live: liveAgentActions(id) ?? [], step: liveAgentStep(id), liveText: liveAgentText(id), approvals: pendingApprovals(id), suggestions, permissions: { mode: settings.agentMode, threshold: settings.agentThresholdSec }, provider, choice: { model: settings.agentModels[settings.agentProvider], effort: settings.agentEfforts[settings.agentProvider], apiModel: env().ANTHROPIC_MODEL } }}
      exportQuality={settings.defaults.exportQuality}
      exportFolder={settings.exportFolder}
    />
  );
}

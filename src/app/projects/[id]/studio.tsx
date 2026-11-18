"use client";
import type { AgentActionLog, AgentSuggestion } from "@/lib/domain";
import type { AgentMode, AgentProviderId, AgentProviderStatus, ExportQuality } from "@/lib/app-settings-shared";
import type { DockMessage } from "./agent-dock";
import type { EditorProject } from "./types";
import { MediaWorkspace } from "./media-workspace";

export interface AgentView {
  messages: DockMessage[];
  busy: boolean;
  live: AgentActionLog[];
  step: string | null;
  /** What the agent is writing right now (Claude Code and Codex stream it). */
  liveText: string | null;
  /** Permission questions from Claude Code or Codex waiting for the user: «Permitir» / «Rechazar». */
  approvals: { id: string; title: string; detail: string }[];
  suggestions: AgentSuggestion[];
  /** How much the agent may run on its own (Ajustes, or the composer's picker). */
  permissions: { mode: AgentMode; threshold: number };
  /** What runs the agent (Ajustes › Agente) and, when it cannot run now, what to do about it; `statuses`: every engine. */
  provider: { id: AgentProviderId; label: string; problem: string | null; statuses: AgentProviderStatus[] };
  /** The model and effort the next message runs with (the composer's model picker), and the API's default model. */
  choice: { model: string; effort: string; apiModel: string };
}

/** One studio for every project. Script generation and media are tools inside it. */
export function Studio({ project, agent, exportQuality, exportFolder }: { project: EditorProject; version: number; agent: AgentView; exportQuality: ExportQuality; exportFolder: string }) {
  return <MediaWorkspace key={project.id} project={project} agent={agent} exportQuality={exportQuality} exportFolder={exportFolder} />;
}

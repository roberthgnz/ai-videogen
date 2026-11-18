"use server";

import { t as translate } from "@/lib/i18n";
import { refresh } from "next/cache";
import { AGENT_MODES, AGENT_PROVIDERS, getAppSettings, saveAppSettings, type AgentMode, type AgentProviderId, type AgentProviderStatus, type AppSettings } from "@/lib/app-settings";
import { allProviderStatuses, listCodexModels, publicStatus } from "@/lib/agent/cli";
import type { AgentChoice, EngineCatalog } from "@/lib/agent-models";
import { env } from "@/lib/env";

// Local single-user app (bound to 127.0.0.1): no auth checks by design.

export async function saveAppSettingsAction(input: unknown): Promise<{ ok: true; settings: AppSettings } | { ok: false; error: string }> {
  // The form does not edit the export folder: an export made while Ajustes was open must not be undone by its save.
  const current = getAppSettings();
  const result = saveAppSettings(input && typeof input === "object" ? { ...input, exportFolder: current.exportFolder } : input);
  if (result.ok && result.settings.language === current.language) refresh();
  return result;
}

/** «Comprobar de nuevo» in Ajustes › Agente: looks for the installed programs and their sign-in again, now. */
export async function checkAgentProvidersAction(): Promise<AgentProviderStatus[]> {
  const statuses = (await allProviderStatuses(true)).map(publicStatus);
  refresh();
  return statuses;
}

/** The engine picker in the agent's composer: only the engine changes. */
export async function setAgentEngineAction(provider: AgentProviderId): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!AGENT_PROVIDERS.includes(provider)) return { ok: false, error: translate("Invalid engine.") };
  const result = saveAppSettings({ ...getAppSettings(), agentProvider: provider });
  if (!result.ok) return result;
  refresh();
  return { ok: true };
}

/** What the model picker in a message box starts from: the engine, model and effort the next message runs with. */
export async function agentChoiceAction(): Promise<{ choice: AgentChoice; statuses: AgentProviderStatus[]; apiModel: string }> {
  const settings = getAppSettings();
  const provider = settings.agentProvider;
  return {
    choice: { provider, model: settings.agentModels[provider], effort: settings.agentEfforts[provider] },
    statuses: (await allProviderStatuses()).map(publicStatus),
    apiModel: env().ANTHROPIC_MODEL,
  };
}

/** Codex's models, read from the program (a few seconds the first time, then kept for a while). */
export async function codexModelsAction(fresh = false): Promise<EngineCatalog> {
  return listCodexModels(fresh === true);
}

/** A model (and its effort) picked in a message box: that engine runs the next message with them. */
export async function setAgentChoiceAction(choice: AgentChoice): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!AGENT_PROVIDERS.includes(choice?.provider)) return { ok: false, error: translate("Invalid engine.") };
  const current = getAppSettings();
  const result = saveAppSettings({
    ...current,
    agentProvider: choice.provider,
    agentModels: { ...current.agentModels, [choice.provider]: choice.model },
    agentEfforts: { ...current.agentEfforts, [choice.provider]: choice.effort },
  });
  if (!result.ok) return { ok: false, error: translate("Could not be saved: {0}", result.error) };
  refresh();
  return { ok: true };
}

/** The permissions picker in the agent's composer: only the mode and its limit change. */
export async function setAgentPermissionsAction(mode: AgentMode, thresholdSec: number): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!AGENT_MODES.includes(mode)) return { ok: false, error: translate("Invalid mode.") };
  const result = saveAppSettings({ ...getAppSettings(), agentMode: mode, agentThresholdSec: thresholdSec });
  if (!result.ok) return result;
  refresh();
  return { ok: true };
}

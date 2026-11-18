import { t as translate, localizedLabels } from "@/lib/i18n";
import { z } from "zod";
import { VIDEO_FORMATS } from "./domain";
import { PRESET_IDS } from "@/presets";
import { t } from "./i18n";
import { LANGUAGE_PREFERENCES, languagePreference } from "./i18n/locale";

/** Client-safe half of the app settings: the shape, the choices and their defaults (no file access). */

/**
 * - "threshold": edits run at once; a voice or a video runs on its own only while it lasts at most
 *   `agentThresholdSec`, longer ones wait for the user's click.
 * - "confirm": edits run; voice and video always wait for a click.
 * - "auto": everything runs at once.
 */
export const AGENT_MODES = ["threshold", "confirm", "auto"] as const;
export type AgentMode = (typeof AGENT_MODES)[number];
export const AGENT_THRESHOLDS = [30, 60, 120, 300] as const;
export const EXPORT_QUALITIES = ["draft", "looks", "delivery"] as const;
export type ExportQuality = (typeof EXPORT_QUALITIES)[number];

/**
 * What runs the agent: the Anthropic API with the app's key, or an AI program the user already has installed
 * and signed in on this computer (it uses their own account and the studio's tools).
 */
export const AGENT_PROVIDERS = ["anthropic", "claude-code", "codex"] as const;
export type AgentProviderId = (typeof AGENT_PROVIDERS)[number];
export type CliProviderId = Exclude<AgentProviderId, "anthropic">;

export const AGENT_PROVIDER_INFO: Record<AgentProviderId, { label: string; hint: string }> = localizedLabels((translate) => ({
  anthropic: { label: "API de Anthropic", hint: translate("Claude with the API key of the app.") },
  "claude-code": { label: "Claude Code", hint: translate("Your Claude Code, with your account and its tools (terminal, files, web, skills) plus those of the studio.") },
  codex: { label: "Codex", hint: translate("Your Codex, with your ChatGPT or OpenAI account and its tools plus those in the study.") },
}));

/**
 * Whether a provider can run the agent right now. `problem` says what is missing and how to fix
 * it; it is null when `state` is "ready".
 */
export interface AgentProviderStatus {
  id: AgentProviderId;
  state: "ready" | "missing" | "signed-out" | "error";
  /** Version and account, e.g. "2.1.3 · cuenta de Claude (max)". */
  detail: string;
  problem: string | null;
}

/** A model name goes on the program's command line: letters, digits and . _ - : / @ [ ] only. */
const cliModel = z.string().trim().max(80).regex(/^[\w.:/@[\]-]*$/, "The model name only supports letters, numbers and. _ -: / @ []").default("");
/** How hard the model thinks (low, medium, high…, as each engine names it); empty lets the model decide. */
const effort = z.string().trim().max(20).regex(/^[a-z]*$/, "Invalid level of reasoning").default("");

export const appSettingsSchema = z.object({
  language: z.preprocess(languagePreference, z.enum(LANGUAGE_PREFERENCES)),
  agentMode: z.enum(AGENT_MODES).default("threshold"),
  agentThresholdSec: z.coerce.number().int().min(10).max(600).default(60),
  agentProvider: z.enum(AGENT_PROVIDERS).default("anthropic"),
  /** Model per engine; empty uses the engine's own default (ANTHROPIC_MODEL for the API). */
  agentModels: z.object({
    anthropic: cliModel,
    "claude-code": cliModel,
    codex: cliModel,
  }).prefault({}),
  /** Reasoning effort per engine, chosen next to the model in the message box. */
  agentEfforts: z.object({
    anthropic: effort,
    "claude-code": effort,
    codex: effort,
  }).prefault({}),
  defaults: z.object({
    format: z.enum(VIDEO_FORMATS).default("vertical"),
    preset: z.enum(PRESET_IDS).default("viral"),
    targetDurationSec: z.coerce.number().int().min(10).max(180).default(45),
    tone: z.string().trim().max(60).default(() => t("informative")),
    voiceId: z.string().max(100).nullable().default(null),
    music: z.enum(["auto", "none"]).default("auto"),
    sfx: z.boolean().default(true),
    exportQuality: z.enum(EXPORT_QUALITIES).default("looks"),
  }).prefault({}),
  /** Folder the last export was saved to (desktop); empty means the system's Videos folder. Kept by the studio, not by Ajustes. */
  exportFolder: z.string().max(1024).default(""),
});

export type AppSettings = z.infer<typeof appSettingsSchema>;

/** Rough spoken length of a narration, in seconds (Spanish TTS reads ~2.6 words a second). */
export function narrationSeconds(narrations: string[]): number {
  const words = narrations.join(" ").split(/\s+/).filter(Boolean).length;
  return Math.round(words / 2.6);
}

/** Why the agent may not start a generation of `seconds` on its own, or null if it may. */
export function generationNeedsApproval(settings: AppSettings, seconds: number): string | null {
  if (settings.agentMode === "auto") return null;
  if (settings.agentMode === "confirm") return translate("the permits ask to confirm each generation");
  return seconds > settings.agentThresholdSec ? translate("lasts about {0} s and the automatic limit is {1} s", seconds, settings.agentThresholdSec) : null;
}

export function describeAgentMode(settings: AppSettings): string {
  if (settings.agentMode === "auto") return translate("Automatic execution: you can generate voice and video without asking for confirmation.");
  if (settings.agentMode === "confirm") return translate("Confirm changes: the voice and video are NOT released alone; propose them with propose_actions and the user approves them.");
  return translate("Automatic under threshold: generates voice or video only if it lasts at least {0} s; if not, propose it with propose_actions.", settings.agentThresholdSec);
}

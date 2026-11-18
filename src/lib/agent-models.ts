import { localizedLabels } from "@/lib/i18n";
import type { AgentProviderId } from "./app-settings-shared";

/**
 * The models each engine can run and how hard each one may think, for the picker in the message box. Client
 * safe: the Anthropic and Claude Code lists are fixed here; Codex's comes from the program itself.
 */

export interface EngineModel {
  /** What goes to the engine; empty means «the engine's own default». */
  id: string;
  label: string;
  hint?: string;
  /** Reasoning levels this model takes, lowest first. */
  efforts: string[];
  /** The level it uses when none is chosen, when known. */
  defaultEffort?: string;
}

/** What the picker shows for one engine: its models and the one that runs when none is chosen. */
export interface EngineCatalog {
  models: EngineModel[];
  /** The model the engine runs with the setting empty (the API's ANTHROPIC_MODEL), when known. */
  defaultModel?: string;
  /** Why the list could not be read (Codex not installed or signed out). */
  problem?: string;
}

/** The engine, its model and its effort as saved: what the next message runs with. */
export interface AgentChoice {
  provider: AgentProviderId;
  model: string;
  effort: string;
}

const EFFORT_LABEL: Record<string, string> = localizedLabels((translate) => ({
  none: translate("Unreasoned"),
  minimal: translate("Minimum"),
  low: "Bajo",
  medium: translate("Medium"),
  high: translate("Stop"),
  xhigh: "Muy alto",
  max: translate("Maximum"),
  ultra: "Ultra",
}));
const EFFORT_HINT: Record<string, string> = localizedLabels((translate) => ({
  none: "Responde directamente",
  minimal: translate("The fastest"),
  low: translate("Quick, for simple changes"),
  medium: "Equilibrio entre rapidez y calidad",
  high: translate("Think more of every step"),
  xhigh: translate("For long or difficult assembly"),
  max: translate("The slowest; for the most difficult"),
  ultra: translate("The maximum it offers; the slowest"),
}));
export const effortLabel = (id: string) => EFFORT_LABEL[id] ?? id;
export const effortHint = (id: string) => EFFORT_HINT[id];

export const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
type ClaudeEffort = (typeof CLAUDE_EFFORTS)[number];
export const isClaudeEffort = (value: string): value is ClaudeEffort => (CLAUDE_EFFORTS as readonly string[]).includes(value);

export const ANTHROPIC_MODELS: EngineModel[] = localizedLabels((translate) => ([
  { id: "claude-opus-5-5", label: "Claude Opus 5.5", hint: translate("Very capable and agile: the recommended"), efforts: [...CLAUDE_EFFORTS], defaultEffort: "medium" },
  { id: "claude-fable-5-2", label: "Claude Fable 5.2", hint: translate("The most capable; the slower and most expensive"), efforts: [...CLAUDE_EFFORTS], defaultEffort: "high" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", hint: translate("Fast for day to day"), efforts: [...CLAUDE_EFFORTS], defaultEffort: "high" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5", hint: translate("The fastest and cheapest, for simple things"), efforts: [...CLAUDE_EFFORTS], defaultEffort: "medium" },
]));

/** Claude Code takes aliases that follow the latest version of each model. */
export const CLAUDE_CODE_MODELS: EngineModel[] = localizedLabels((translate) => ([
  { id: "", label: translate("Your Claude Code's"), hint: "El modelo que tengas elegido en Claude Code", efforts: [...CLAUDE_EFFORTS] },
  { id: "opus", label: "Opus", hint: translate("The latest version of Opus"), efforts: [...CLAUDE_EFFORTS] },
  { id: "fable", label: "Fable", hint: translate("The latest version of Fable: the most capable"), efforts: [...CLAUDE_EFFORTS] },
  { id: "sonnet", label: "Sonnet", hint: translate("The latest version of Sonnet: faster"), efforts: [...CLAUDE_EFFORTS] },
]));

/** The entry that runs for `model` (the default one when it is empty), or a bare one for a name typed in Ajustes. */
export function findModel(catalog: EngineCatalog, model: string): EngineModel | undefined {
  const id = model || catalog.defaultModel || "";
  return catalog.models.find((m) => m.id === id) ?? (id ? { id, label: id, efforts: [] } : undefined);
}

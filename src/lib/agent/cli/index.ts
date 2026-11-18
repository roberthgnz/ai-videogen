import type { CliProviderId } from "@/lib/app-settings-shared";
import { runClaudeCode } from "./claude-code";
import { runCodex } from "./codex";
import type { CliTurn } from "./shared";

export { allProviderStatuses, providerStatus, publicStatus } from "./detect";
export { listCodexModels } from "./codex";
export { toolCaller, type CliTurn } from "./shared";
export { resetSession as resetAgentSession } from "./workspace";

/** Runs one agent turn through an installed AI program; resolves with its reply to the user. */
export function runCliTurn(provider: CliProviderId, turn: CliTurn): Promise<string> {
  return provider === "claude-code" ? runClaudeCode(turn) : runCodex(turn);
}

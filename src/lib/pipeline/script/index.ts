import { AnthropicScriptGenerator } from "./anthropic";
import type { ScriptGenerator } from "./types";

export type { ScriptGenerator, ScriptRequest } from "./types";

/** The script generator the app uses. Swap the implementation here. */
export function getScriptGenerator(): ScriptGenerator {
  return new AnthropicScriptGenerator();
}

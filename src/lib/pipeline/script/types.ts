import type { VideoFormat } from "@/lib/domain";
import type { ScriptDraft } from "@/lib/script/schema";
import type { EditDocument } from "@/lib/editing/schema";

export interface ScriptRequest {
  topic: string;
  targetDurationSec: number;
  tone: string;
  format: VideoFormat;
  /** How fast the project's voice really speaks, when known: the word budget follows it. */
  wordsPerSecond?: number;
  /** User references and their observed narrative/visual plan, as data rather than instructions. */
  references?: { title: string; roles: string[]; content: string; transcript?: string; analysis?: unknown }[];
  direction?: EditDocument["direction"];
}

/**
 * Script step: topic + settings -> validated script draft.
 * Implementations must return a draft that passes `scriptDraftSchema`
 * and `scriptRuleIssues`, or throw a PipelineError("script", ...).
 */
export interface ScriptGenerator {
  readonly name: string;
  generate(request: ScriptRequest, options?: { signal?: AbortSignal }): Promise<ScriptDraft>;
}

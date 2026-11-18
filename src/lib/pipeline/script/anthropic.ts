import { t as translate } from "@/lib/i18n";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { env, requireSecret } from "@/lib/env";
import { countWords, scriptBudget, scriptDraftSchema, scriptRuleIssues, type ScriptDraft } from "@/lib/script/schema";
import { PipelineError } from "../errors";
import { buildSystemPrompt, buildUserPrompt } from "./prompt";
import type { ScriptGenerator, ScriptRequest } from "./types";

type CreateMessage = (
  params: Anthropic.Beta.MessageCreateParamsNonStreaming,
  options?: { signal?: AbortSignal },
) => Promise<Anthropic.Beta.BetaMessage>;

interface Options {
  model?: string;
  /** Validation retries after the first attempt. */
  maxRetries?: number;
  /** Injected in tests; defaults to the real SDK client. */
  createMessage?: CreateMessage;
}

const OUTPUT_FORMAT = betaZodOutputFormat(scriptDraftSchema);

/** How far a script's word count may sit from its budget before the model is asked to fix it. */
const LENGTH_TOLERANCE = 0.12;

/**
 * Script generator backed by the Anthropic Messages API with structured
 * outputs. The JSON is validated here with zod (+ structural rules) and, if
 * invalid, the model gets one more try with the exact issues.
 */
export class AnthropicScriptGenerator implements ScriptGenerator {
  readonly name = "anthropic";
  private readonly model: string;
  private readonly maxRetries: number;
  private readonly createMessage: CreateMessage;

  constructor(options: Options = {}) {
    this.model = options.model ?? env().ANTHROPIC_MODEL;
    this.maxRetries = options.maxRetries ?? 1;
    this.createMessage =
      options.createMessage ??
      ((params, opts) => {
        const client = new Anthropic({ apiKey: requireSecret("ANTHROPIC_API_KEY") });
        return client.beta.messages.create(params, opts);
      });
  }

  async generate(request: ScriptRequest, options: { signal?: AbortSignal } = {}): Promise<ScriptDraft> {
    if (!request.topic.trim()) {
      throw new PipelineError("script", translate("Write a theme before you generate the script."));
    }

    const system = buildSystemPrompt(request);
    let retry: { previousOutput: string; issues: string[] } | undefined;
    // The video lasts what the voice says: a script far from its word budget misses the length asked for.
    const budget = scriptBudget(request.targetDurationSec, request.wordsPerSecond).words;
    let closest: { draft: ScriptDraft; miss: number } | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const message = await this.call(system, buildUserPrompt(request, retry), options.signal);
      const text = lastText(message);
      const result = parseDraft(text);
      if (!result.ok) {
        retry = { previousOutput: text, issues: result.issues };
        continue;
      }
      const words = countWords(result.draft.scenes.map((s) => s.narration).join(" "));
      const miss = Math.abs(words - budget) / budget;
      if (!closest || miss < closest.miss) closest = { draft: result.draft, miss };
      if (miss <= LENGTH_TOLERANCE) return result.draft;
      retry = { previousOutput: text, issues: [translate("The narrative adds {0} words and the budget is {1} (± 10%): {2} up to some {3} without changing the structure or number of scenes.", words, budget, words < budget ? translate("alargala") : translate("Tie her up"), budget)] };
    }
    // Still off after the retry: the closest valid script is better than no script.
    if (closest) return closest.draft;

    throw new PipelineError(
      "script",
      translate("The generated script did not pass validation after {0} attempts:\n- {1}", this.maxRetries + 1, retry!.issues.join("\n- ")),
      { retryable: true },
    );
  }

  private async call(system: string, user: string, signal?: AbortSignal): Promise<Anthropic.Beta.BetaMessage> {
    let message: Anthropic.Beta.BetaMessage;
    try {
      message = await this.createMessage(
        {
          model: this.model,
          max_tokens: 16000,
          // Server-side fallback if the model declines; routes by refusal category.
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          output_config: { effort: "medium", format: OUTPUT_FORMAT },
          system,
          messages: [{ role: "user", content: user }],
        },
        { signal },
      );
    } catch (error) {
      throw toPipelineError(error);
    }

    if (message.stop_reason === "refusal") {
      const category = message.stop_details?.category ?? translate("no category");
      throw new PipelineError("script", translate("The model refused to generate this script ({0}). Try another focus of the topic.", category));
    }
    if (message.stop_reason === "max_tokens") {
      throw new PipelineError("script", translate("The response of the model was cut (max_tokens]. It reduces the target duration."), {
        retryable: true,
      });
    }
    return message;
  }
}

function lastText(message: Anthropic.Beta.BetaMessage): string {
  const texts = message.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text");
  return texts.at(-1)?.text ?? "";
}

type ParseResult = { ok: true; draft: ScriptDraft } | { ok: false; issues: string[] };

export function parseDraft(text: string): ParseResult {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, issues: [translate("The answer is not JSON valid.")] };
  }
  const parsed = scriptDraftSchema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => `${i.path.join(".") || translate("(root)")}: ${i.message}`),
    };
  }
  const draft = normalizeDraft(parsed.data);
  const ruleIssues = scriptRuleIssues(draft);
  if (ruleIssues.length) return { ok: false, issues: ruleIssues };
  return { ok: true, draft };
}

/** Trims every string so stray whitespace never reaches TTS or the screen. */
function normalizeDraft(draft: ScriptDraft): ScriptDraft {
  const trimDeep = (v: unknown): unknown =>
    typeof v === "string" ? v.trim() : Array.isArray(v) ? v.map(trimDeep) : v;
  return {
    title: draft.title.trim(),
    scenes: draft.scenes.map((scene) => ({
      ...scene,
      narration: scene.narration.trim(),
      visuals: scene.visuals.map((q) => q.trim()),
      content: Object.fromEntries(Object.entries(scene.content).map(([k, v]) => [k, trimDeep(v)])),
    })) as ScriptDraft["scenes"],
  };
}

function toPipelineError(error: unknown): PipelineError {
  if (error instanceof PipelineError) return error;
  if (error instanceof Anthropic.APIUserAbortError) {
    return new PipelineError("script", translate("Generation cancelled."), { cause: error });
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return new PipelineError("script", translate("Could not connect to Anthropic API: {0}", error.message), {
      retryable: true,
      cause: error,
    });
  }
  if (error instanceof Anthropic.AuthenticationError) {
    return new PipelineError(
      "script",
      translate("Anthropic 401: the key ANTHROPIC_API_KEY of .env.local is not valid ({0})", error.message),
      { cause: error },
    );
  }
  if (error instanceof Anthropic.NotFoundError) {
    return new PipelineError(
      "script",
      translate("Anthropic 404: check ANTHROPIC_MODEL at .env.local ({0})", error.message),
      { cause: error },
    );
  }
  if (error instanceof Anthropic.RateLimitError) {
    return new PipelineError("script", translate("Anthropic 429 (limit of use): {0}", error.message), {
      retryable: true,
      cause: error,
    });
  }
  if (error instanceof Anthropic.APIError) {
    const status = error.status ?? "?";
    const retryable = typeof error.status === "number" && error.status >= 500;
    return new PipelineError("script", `Anthropic ${status}: ${error.message}`, { retryable, cause: error });
  }
  return new PipelineError("script", error instanceof Error ? error.message : String(error), { cause: error });
}

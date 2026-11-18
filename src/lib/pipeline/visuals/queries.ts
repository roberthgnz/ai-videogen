import { t as translate } from "@/lib/i18n";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { env, requireSecret } from "@/lib/env";
import { visualQueriesSchema } from "@/lib/script/schema";
import { errorMessage, PipelineError } from "../errors";
import { VISUAL_QUERY_RULES } from "../script/prompt";

export interface QueryScene {
  narration: string;
  /** On-screen text, as extra context. */
  onScreen: string;
}

/** Writes the b-roll searches for scenes that have none (older scripts, scenes added by hand). */
export type VisualQueryGenerator = (
  context: { title: string; scenes: QueryScene[] },
  options?: { signal?: AbortSignal },
) => Promise<string[][]>;

const outputSchema = z.object({ scenes: z.array(z.object({ visuals: visualQueriesSchema })) });
const OUTPUT_FORMAT = betaZodOutputFormat(outputSchema);

export const generateVisualQueries: VisualQueryGenerator = async ({ title, scenes }, options = {}) => {
  if (scenes.length === 0) return [];
  const client = new Anthropic({ apiKey: requireSecret("ANTHROPIC_API_KEY") });
  const list = scenes
    .map((s, i) => translate("{0}. Narration: {1}{2}", i + 1, s.narration, s.onScreen ? translate("\n   On screen: {0}", s.onScreen) : ""))
    .join("\n");
  let text: string;
  try {
    const message = await client.beta.messages.create(
      {
        model: env().ANTHROPIC_MODEL,
        max_tokens: 4000,
        output_config: { effort: "low", format: OUTPUT_FORMAT },
        system: translate("You choose the b-roll of short-story videos. For each scene you return \"visuals\": {0} Returns exactly one entry per scene, in the same order.", VISUAL_QUERY_RULES),
        messages: [{ role: "user", content: translate("Video: {0}\n\nScenes:\n{1}", title, list) }],
      },
      { signal: options.signal },
    );
    const blocks = message.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text");
    text = blocks.at(-1)?.text ?? "";
  } catch (error) {
    throw new PipelineError("visuals", translate("B-roll searches could not be generated: {0}", errorMessage(error)), {
      retryable: true,
      cause: error,
    });
  }

  let parsed: z.infer<typeof outputSchema>;
  try {
    parsed = outputSchema.parse(JSON.parse(text));
  } catch (error) {
    throw new PipelineError("visuals", translate("The generated b-roll searches are not valid: {0}", errorMessage(error)), {
      retryable: true,
    });
  }
  if (parsed.scenes.length !== scenes.length) {
    throw new PipelineError("visuals", translate("The model did not return b-roll searches for all the scenes."), { retryable: true });
  }
  return parsed.scenes.map((s) => s.visuals.map((q) => q.trim()));
};

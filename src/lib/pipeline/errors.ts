export type PipelineStep = "script" | "tts" | "alignment" | "visuals" | "composition" | "render";

/**
 * An error meant to be shown in the UI as-is. `message` keeps the real
 * provider error (status + text) so failures can be diagnosed from the UI.
 */
export class PipelineError extends Error {
  readonly step: PipelineStep;
  /** Whether retrying the same step may succeed (network, rate limit, 5xx). */
  readonly retryable: boolean;

  constructor(step: PipelineStep, message: string, options: { retryable?: boolean; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = "PipelineError";
    this.step = step;
    this.retryable = options.retryable ?? false;
  }
}

/** Message to store/show for any thrown value. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

import { t as translate } from "@/lib/i18n";
import type { WordTiming } from "@/lib/domain";
import { PipelineError } from "../errors";
import type { TtsAlignment } from "../tts/types";
import { wordsFromSegments } from "./segments";
import { charsToWords } from "./words";

export { charsToWords } from "./words";
export { displayTokens, normalizeWord, wordsFromSegments } from "./segments";

/**
 * Alignment step: provider timings -> caption word timings for `text`.
 * - character timings (ElevenLabs) are grouped into words,
 * - word timings (Fish Audio, normalized text) are mapped back onto the original words.
 * A provider without timings (e.g. a future local TTS) would plug a
 * transcription-based aligner in here.
 */
export function alignWords(text: string, alignment: TtsAlignment | null): WordTiming[] {
  if (!alignment) {
    throw new PipelineError(
      "alignment",
      translate("The voice provider did not return times; subtitles cannot be synchronized."),
    );
  }
  try {
    const words = alignment.type === "characters" ? charsToWords(alignment) : wordsFromSegments(text, alignment.words);
    if (words.length === 0) throw new Error(translate("The alignment does not contain words."));
    return words;
  } catch (error) {
    if (error instanceof PipelineError) throw error;
    throw new PipelineError("alignment", error instanceof Error ? error.message : String(error), { cause: error });
  }
}

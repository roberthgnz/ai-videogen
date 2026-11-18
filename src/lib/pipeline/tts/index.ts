import { ttsProviderId } from "@/lib/env";
import { CachedTts } from "./cache";
import { ElevenLabsTts } from "./elevenlabs";
import { FishAudioTts } from "./fishaudio";
import type { TtsProvider } from "./types";

export type { CharAlignment, TtsAlignment, TtsProvider, TtsRequest, TtsResult, Voice, WordSegment } from "./types";
export { CachedTts, ttsCacheKey } from "./cache";

/**
 * The TTS provider the app uses, chosen by TTS_PROVIDER (fishaudio | elevenlabs).
 * To add one (e.g. a local TTS), implement TtsProvider and add it here.
 */
export function getTtsProvider(): TtsProvider {
  switch (ttsProviderId()) {
    case "fishaudio":
      return new FishAudioTts();
    case "elevenlabs":
      return new ElevenLabsTts();
  }
}

export function getCachedTts(): CachedTts {
  return new CachedTts(getTtsProvider());
}

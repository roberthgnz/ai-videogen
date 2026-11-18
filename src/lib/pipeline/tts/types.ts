/** Per-character timing (ElevenLabs), seconds from audio start. */
export interface CharAlignment {
  type: "characters";
  characters: string[];
  starts: number[];
  ends: number[];
}

/** One spoken word as the provider transcribed it (may be normalized: no punctuation, numbers spelled out). */
export interface WordSegment {
  text: string;
  start: number;
  end: number;
}

/** Per-word timing (Fish Audio), seconds from audio start. */
export interface WordAlignment {
  type: "words";
  words: WordSegment[];
}

export type TtsAlignment = CharAlignment | WordAlignment;

export interface TtsRequest {
  text: string;
  voiceId: string;
}

export interface TtsResult {
  audio: Buffer;
  /** File extension matching the audio encoding (no dot). */
  extension: string;
  /**
   * Timings for `text`, or null if the provider has none
   * (a local TTS would then need a transcription-based aligner).
   */
  alignment: TtsAlignment | null;
}

export interface Voice {
  id: string;
  name: string;
  /** Grouping label for the picker (e.g. "Mis voces", "premade"). */
  category?: string;
  description?: string | null;
  labels?: Record<string, string>;
  previewUrl?: string | null;
}

/**
 * TTS step: text + voice -> audio (+ timings when available).
 * Implementations: Fish Audio, ElevenLabs; a local TTS later.
 */
export interface TtsProvider {
  /** Stable id, part of the cache key. */
  readonly id: string;
  /** Every setting besides text and voice that changes the audio. Part of the cache key. */
  cacheKeyParts(): Record<string, unknown>;
  synthesize(request: TtsRequest, options?: { signal?: AbortSignal }): Promise<TtsResult>;
  listVoices(options?: { signal?: AbortSignal }): Promise<Voice[]>;
}

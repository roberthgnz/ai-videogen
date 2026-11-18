import { t as translate } from "@/lib/i18n";
import { z } from "zod";

/** Empty strings in .env files mean "not set". */
const optional = z.preprocess((v) => (v === "" ? undefined : v), z.string().optional());
const withDefault = (fallback: string) =>
  z.preprocess((v) => (v === "" || v === undefined ? fallback : v), z.string());

export const TTS_PROVIDERS = ["fishaudio", "elevenlabs"] as const;
export type TtsProviderId = (typeof TTS_PROVIDERS)[number];

const schema = z.object({
  ANTHROPIC_API_KEY: optional,
  ANTHROPIC_MODEL: withDefault("claude-opus-5-5"),

  /** Which TTS provider to use. Unset: Fish Audio if its key is set, else ElevenLabs. */
  TTS_PROVIDER: z.preprocess((v) => (v === "" ? undefined : v), z.enum(TTS_PROVIDERS).optional()),
  /** Voice preselected for new projects (an id of the active provider). */
  TTS_DEFAULT_VOICE_ID: optional,

  FISH_AUDIO_API_KEY: optional,
  FISH_AUDIO_MODEL: withDefault("s2.1-pro"),
  /** BCP-47 tag; Fish Audio uses it for text normalization and word timestamps. */
  FISH_AUDIO_LANGUAGE: optional,

  ELEVENLABS_API_KEY: optional,
  ELEVENLABS_MODEL_ID: withDefault("eleven_multilingual_v2"),

  /** Stock video and images for b-roll (https://pixabay.com/api/docs/). Unset: scenes keep the animated background. */
  PIXABAY_API_KEY: optional,

  STORAGE_DIR: withDefault("./storage"),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

/** Parsed server environment. Keys are optional so the app boots without them. */
export function env(): Env {
  cached ??= schema.parse(process.env);
  return cached;
}

export function ttsProviderId(): TtsProviderId {
  const e = env();
  return e.TTS_PROVIDER ?? (e.FISH_AUDIO_API_KEY ? "fishaudio" : "elevenlabs");
}

type SecretKey = "ANTHROPIC_API_KEY" | "ELEVENLABS_API_KEY" | "FISH_AUDIO_API_KEY" | "PIXABAY_API_KEY";

/** Returns a secret or throws an error meant to be shown in the UI. */
export function requireSecret(key: SecretKey): string {
  const value = env()[key];
  if (!value) {
    throw new Error(process.env.VIDEOGEN_DESKTOP === "1"
      ? translate("It is missing {0}. Configure it in Adjustments and reboot VideoGen.", key)
      : translate("{0} is missing in .env.local (copy .env. example and fill it out).", key));
  }
  return value;
}

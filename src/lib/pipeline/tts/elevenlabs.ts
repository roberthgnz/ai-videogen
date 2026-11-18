import { t as translate } from "@/lib/i18n";
import { env, requireSecret } from "@/lib/env";
import { PipelineError } from "../errors";
import type { CharAlignment, TtsProvider, TtsRequest, TtsResult, Voice } from "./types";

const API = "https://api.elevenlabs.io";
const OUTPUT_FORMAT = "mp3_44100_128";

/** Defaults documented by ElevenLabs; tweak here (changes invalidate the TTS cache). */
const VOICE_SETTINGS = {
  stability: 0.5,
  similarity_boost: 0.75,
  style: 0,
  use_speaker_boost: true,
  speed: 1,
};

type Fetch = typeof fetch;

interface Options {
  modelId?: string;
  /** Injected in tests. */
  fetch?: Fetch;
  /** Injected in tests; defaults to ELEVENLABS_API_KEY. */
  apiKey?: () => string;
}

interface AlignmentJson {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
}

interface WithTimestampsJson {
  audio_base64: string;
  alignment?: AlignmentJson | null;
  normalized_alignment?: AlignmentJson | null;
}

interface VoicesJson {
  voices: {
    voice_id: string;
    name?: string;
    category?: string;
    description?: string | null;
    labels?: Record<string, string>;
    preview_url?: string | null;
  }[];
  has_more: boolean;
  next_page_token?: string | null;
}

export class ElevenLabsTts implements TtsProvider {
  readonly id = "elevenlabs";
  private readonly modelId: string;
  private readonly fetch: Fetch;
  private readonly apiKey: () => string;

  constructor(options: Options = {}) {
    this.modelId = options.modelId ?? env().ELEVENLABS_MODEL_ID;
    this.fetch = options.fetch ?? fetch;
    this.apiKey = options.apiKey ?? (() => requireSecret("ELEVENLABS_API_KEY"));
  }

  cacheKeyParts() {
    return { model: this.modelId, outputFormat: OUTPUT_FORMAT, voiceSettings: VOICE_SETTINGS };
  }

  async synthesize(request: TtsRequest, options: { signal?: AbortSignal } = {}): Promise<TtsResult> {
    const url = `${API}/v1/text-to-speech/${encodeURIComponent(request.voiceId)}/with-timestamps?output_format=${OUTPUT_FORMAT}`;
    const json = await this.request<WithTimestampsJson>(url, {
      method: "POST",
      body: JSON.stringify({
        text: request.text,
        model_id: this.modelId,
        voice_settings: VOICE_SETTINGS,
      }),
      signal: options.signal,
    });

    if (!json.audio_base64) throw new PipelineError("tts", translate("ElevenLabs responded without audio."), { retryable: true });
    const audio = Buffer.from(json.audio_base64, "base64");
    const raw = json.alignment ?? null;
    const alignment: CharAlignment | null = raw
      ? {
          type: "characters",
          characters: raw.characters,
          starts: raw.character_start_times_seconds,
          ends: raw.character_end_times_seconds,
        }
      : null;
    return { audio, extension: "mp3", alignment };
  }

  async listVoices(options: { signal?: AbortSignal } = {}): Promise<Voice[]> {
    const voices: Voice[] = [];
    let token: string | null | undefined;
    for (let page = 0; page < 10; page++) {
      const params = new URLSearchParams({ page_size: "100", include_total_count: "false", sort: "name" });
      if (token) params.set("next_page_token", token);
      const json = await this.request<VoicesJson>(`${API}/v2/voices?${params}`, {
        method: "GET",
        signal: options.signal,
      });
      for (const v of json.voices) {
        voices.push({
          id: v.voice_id,
          name: v.name ?? v.voice_id,
          category: v.category,
          description: v.description,
          labels: v.labels,
          previewUrl: v.preview_url,
        });
      }
      if (!json.has_more || !json.next_page_token) break;
      token = json.next_page_token;
    }
    return voices;
  }

  private async request<T>(url: string, init: { method: string; body?: string; signal?: AbortSignal }): Promise<T> {
    const signal = init.signal ?? AbortSignal.timeout(120_000);
    // Read the key outside the network try: a missing key is not a connection error.
    const apiKey = this.apiKey();
    let response: Response;
    try {
      response = await this.fetch(url, {
        method: init.method,
        body: init.body,
        signal,
        headers: {
          "xi-api-key": apiKey,
          ...(init.body ? { "content-type": "application/json" } : {}),
          accept: "application/json",
        },
      });
    } catch (error) {
      if (error instanceof PipelineError) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      throw new PipelineError("tts", translate("Could not connect to ElevenLabs: {0}", reason), { retryable: true, cause: error });
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw elevenLabsError(response.status, body);
    }
    return (await response.json()) as T;
  }
}

/** Builds a readable error from an ElevenLabs error response, keeping its real message. */
export function elevenLabsError(status: number, body: string): PipelineError {
  let detail = body.slice(0, 500);
  try {
    const parsed = JSON.parse(body) as { detail?: unknown };
    const d = parsed.detail;
    if (typeof d === "string") detail = d;
    else if (Array.isArray(d)) {
      detail = d.map((e: { loc?: unknown[]; msg?: string }) => `${(e.loc ?? []).join(".")}: ${e.msg}`).join("; ");
    } else if (d && typeof d === "object") {
      const { status: code, message } = d as { status?: string; message?: string };
      detail = [code, message].filter(Boolean).join(": ") || detail;
    }
  } catch {
    // not JSON: keep the raw text
  }

  const hint =
    status === 401
      ? translate(" (check ELEVENLABS_API_KEY at .env.local or your quota)")
      : status === 404
        ? translate(" (Is that voice in your account?)")
        : status === 429
          ? translate(" (limit of requests or concurrence; retry in a moment)")
          : "";
  return new PipelineError("tts", `ElevenLabs ${status}: ${detail}${hint}`, {
    retryable: status === 429 || status >= 500,
  });
}

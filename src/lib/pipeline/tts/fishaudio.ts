import { t as translate, getLocale, t } from "@/lib/i18n";
import { env, requireSecret } from "@/lib/env";
import { PipelineError } from "../errors";
import type { TtsProvider, TtsRequest, TtsResult, Voice, WordSegment } from "./types";

const API = "https://api.fish.audio";

/** Request settings that change the audio (part of the cache key). Server defaults for the rest. */
const AUDIO = { format: "mp3", mp3_bitrate: 128, normalize: true, latency: "normal" } as const;

type Fetch = typeof fetch;

interface Options {
  model?: string;
  language?: string;
  fetch?: Fetch;
  apiKey?: () => string;
}

/** One `message` event of POST /v1/tts/stream/with-timestamp. */
interface StreamEvent {
  audio_base64?: string;
  content?: string;
  alignment?: { audio_duration?: number; segments: WordSegment[] } | null;
  chunk_seq?: number;
  chunk_audio_offset_sec?: number;
  // error payloads
  status?: number;
  message?: string;
}

interface ModelListJson {
  items: {
    _id: string;
    type?: string;
    title?: string;
    description?: string | null;
    languages?: string[];
    samples?: { audio?: string | null }[];
  }[];
}

/**
 * Fish Audio TTS via the streaming-with-timestamps endpoint: the SSE stream
 * carries base64 audio chunks plus word timings per text chunk, which are
 * normalized (no punctuation) and mapped back onto the narration by the
 * alignment step.
 */
export class FishAudioTts implements TtsProvider {
  readonly id = "fishaudio";
  private readonly model: string;
  private readonly language: string;
  private readonly fetch: Fetch;
  private readonly apiKey: () => string;

  constructor(options: Options = {}) {
    this.model = options.model ?? env().FISH_AUDIO_MODEL;
    this.language = options.language ?? env().FISH_AUDIO_LANGUAGE ?? getLocale();
    this.fetch = options.fetch ?? fetch;
    this.apiKey = options.apiKey ?? (() => requireSecret("FISH_AUDIO_API_KEY"));
  }

  cacheKeyParts() {
    return { model: this.model, language: this.language, ...AUDIO };
  }

  async synthesize(request: TtsRequest, options: { signal?: AbortSignal } = {}): Promise<TtsResult> {
    const response = await this.send(`${API}/v1/tts/stream/with-timestamp`, {
      method: "POST",
      signal: options.signal,
      headers: { "content-type": "application/json", accept: "text/event-stream", model: this.model },
      body: JSON.stringify({
        text: request.text,
        reference_id: request.voiceId,
        language: this.language,
        ...AUDIO,
      }),
    });
    return parseTimestampStream(await response.text());
  }

  async listVoices(options: { signal?: AbortSignal } = {}): Promise<Voice[]> {
    const lists: [string, URLSearchParams][] = [
      ["Mis voces", new URLSearchParams({ self: "true", page_size: "100" })],
      [
        t("Popular voices"),
        new URLSearchParams({ language: this.language.split("-")[0], sort_by: "task_count", page_size: "50" }),
      ],
    ];
    const seen = new Set<string>();
    const voices: Voice[] = [];
    for (const [category, params] of lists) {
      const res = await this.send(`${API}/model?${params}`, {
        method: "GET",
        signal: options.signal,
        headers: { accept: "application/json" },
      });
      const json = (await res.json()) as ModelListJson;
      for (const item of json.items ?? []) {
        if (seen.has(item._id) || (item.type && item.type !== "tts")) continue;
        seen.add(item._id);
        const sample = item.samples?.find((s) => s.audio)?.audio ?? null;
        voices.push({
          id: item._id,
          name: item.title || item._id,
          category,
          description: item.description,
          labels: item.languages?.length ? { languages: item.languages.join(", ") } : undefined,
          previewUrl: sample && /^https?:\/\//.test(sample) ? sample : null,
        });
      }
    }
    return voices;
  }

  private async send(
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
  ): Promise<Response> {
    // Read the key outside the network try: a missing key is not a connection error.
    const apiKey = this.apiKey();
    let response: Response;
    try {
      response = await this.fetch(url, {
        method: init.method,
        body: init.body,
        signal: init.signal ?? AbortSignal.timeout(120_000),
        headers: { authorization: `Bearer ${apiKey}`, ...init.headers },
      });
    } catch (error) {
      if (error instanceof PipelineError) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      throw new PipelineError("tts", translate("Could not connect to Fish Audio: {0}", reason), { retryable: true, cause: error });
    }
    if (!response.ok) {
      throw fishAudioError(response.status, await response.text().catch(() => ""), this.model);
    }
    return response;
  }
}

/**
 * Parses the SSE body: concatenates audio chunks in order and keeps the
 * latest alignment snapshot per text chunk, shifted by the chunk's offset.
 */
export function parseTimestampStream(body: string): TtsResult {
  const audio: Buffer[] = [];
  const snapshots = new Map<number, { offset: number; segments: WordSegment[] }>();

  for (const block of body.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") continue;

    let event: StreamEvent;
    try {
      event = JSON.parse(data) as StreamEvent;
    } catch {
      continue;
    }
    if (event.audio_base64 === undefined && event.message) {
      throw new PipelineError("tts", `Fish Audio ${event.status ?? "?"}: ${event.message}`, { retryable: true });
    }
    if (event.audio_base64) audio.push(Buffer.from(event.audio_base64, "base64"));
    if (event.alignment?.segments) {
      snapshots.set(event.chunk_seq ?? 0, {
        offset: event.chunk_audio_offset_sec ?? 0,
        segments: event.alignment.segments,
      });
    }
  }

  if (audio.length === 0) throw new PipelineError("tts", translate("Fish Audio responded without audio."), { retryable: true });
  const words = [...snapshots.entries()]
    .sort(([a], [b]) => a - b)
    .flatMap(([, snap]) =>
      snap.segments.map((s) => ({ text: s.text, start: s.start + snap.offset, end: s.end + snap.offset })),
    );

  return {
    audio: Buffer.concat(audio),
    extension: "mp3",
    alignment: words.length ? { type: "words", words } : null,
  };
}

/** Readable error from a Fish Audio error response ({status, message, reason}). */
export function fishAudioError(status: number, body: string, model: string): PipelineError {
  let detail = body.slice(0, 500);
  try {
    const json = JSON.parse(body) as { message?: string; reason?: string | null };
    detail = [json.message, json.reason].filter(Boolean).join(" — ") || detail;
  } catch {
    // keep raw text
  }
  const hint =
    status === 401
      ? translate(" (check FISH_AUDIO_API_KEY at .env.local)")
      : status === 402
        ? translate(" (without credit for model {0}; recharge balance or use FISH_AUDIO_MODEL = s2.1-pro-free for testing)", model)
        : status === 404 || (status === 400 && /reference/i.test(detail))
          ? translate(" (Is there a voice or a model?)")
          : status === 429
            ? translate(" (limit of concurrence; retry in a moment)")
            : "";
  return new PipelineError("tts", `Fish Audio ${status}: ${detail}${hint}`, {
    retryable: status === 429 || status >= 500,
  });
}

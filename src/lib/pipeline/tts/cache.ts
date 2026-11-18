import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ensureDir, storagePaths } from "@/lib/storage";
import type { TtsAlignment, TtsProvider, TtsRequest } from "./types";

export interface CachedAudio {
  /** Cache key; stored on the scene to detect stale audio. */
  hash: string;
  /** Absolute path of the audio file. */
  audioPath: string;
  alignment: TtsAlignment | null;
  /** True when served from disk without calling the provider. */
  fromCache: boolean;
}

interface Meta {
  hash: string;
  provider: string;
  voiceId: string;
  text: string;
  extension: string;
  keyParts: Record<string, unknown>;
  alignment: TtsAlignment | null;
  createdAt: string;
}

/** JSON with sorted keys, so the hash doesn't depend on property order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Cache key for a TTS request: text + voice + every provider setting that changes the audio. */
export function ttsCacheKey(provider: TtsProvider, request: TtsRequest): string {
  const payload = { v: 1, provider: provider.id, ...provider.cacheKeyParts(), voiceId: request.voiceId, text: request.text };
  return createHash("sha256").update(canonical(payload)).digest("hex");
}

/**
 * Disk cache in front of a TtsProvider: storage/cache/tts/<hash>.<ext> + <hash>.json.
 * The same text with the same voice and settings is never paid for twice.
 */
export class CachedTts {
  constructor(
    readonly provider: TtsProvider,
    private readonly dir: string = storagePaths.ttsCache(),
  ) {}

  key(request: TtsRequest): string {
    return ttsCacheKey(this.provider, request);
  }

  /** Cached entry for a request, or null. Never calls the provider. */
  lookup(request: TtsRequest): CachedAudio | null {
    const hash = this.key(request);
    const metaPath = path.join(/*turbopackIgnore: true*/ this.dir, `${hash}.json`);
    if (!fs.existsSync(metaPath)) return null;
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf8")) as Meta;
      const audioPath = path.join(/*turbopackIgnore: true*/ this.dir, `${hash}.${meta.extension}`);
      if (!fs.existsSync(audioPath) || fs.statSync(audioPath).size === 0) return null;
      return { hash, audioPath, alignment: meta.alignment, fromCache: true };
    } catch {
      return null;
    }
  }

  /**
   * Returns cached audio when present; otherwise synthesizes and stores it.
   * `force` skips the lookup (a new take) and overwrites the entry.
   */
  async get(request: TtsRequest, options: { force?: boolean; signal?: AbortSignal } = {}): Promise<CachedAudio> {
    if (!options.force) {
      const hit = this.lookup(request);
      if (hit) return hit;
    }

    const result = await this.provider.synthesize(request, { signal: options.signal });
    const hash = this.key(request);
    ensureDir(this.dir);
    const audioPath = path.join(/*turbopackIgnore: true*/ this.dir, `${hash}.${result.extension}`);
    const meta: Meta = {
      hash,
      provider: this.provider.id,
      voiceId: request.voiceId,
      text: request.text,
      extension: result.extension,
      keyParts: this.provider.cacheKeyParts(),
      alignment: result.alignment,
      createdAt: new Date().toISOString(),
    };
    // Write audio first, then meta: an entry only counts once its meta exists.
    writeAtomic(audioPath, result.audio);
    writeAtomic(path.join(/*turbopackIgnore: true*/ this.dir, `${hash}.json`), JSON.stringify(meta));
    return { hash, audioPath, alignment: result.alignment, fromCache: false };
  }
}

function writeAtomic(file: string, data: string | Buffer) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

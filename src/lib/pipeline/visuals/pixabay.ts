import { t as translate } from "@/lib/i18n";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { VisualCandidate, VisualFile } from "@/lib/domain";
import { PipelineError } from "../errors";
import type { VisualProvider, VisualSearchRequest } from "./types";

const API = "https://pixabay.com/api/";
/** Pixabay requires search responses to be cached for 24 hours. */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_QUERY_CHARS = 100;

type Fetch = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;

interface Options {
  apiKey: string;
  /** Folder for cached search responses. */
  cacheDir: string;
  /** Injected in tests. */
  fetch?: Fetch;
  now?: () => number;
}

interface VideoHit {
  id: number;
  tags: string;
  pageURL: string;
  duration: number;
  user: string;
  videos: Record<string, { url: string; width: number; height: number; size: number; thumbnail: string } | undefined>;
}

interface ImageHit {
  id: number;
  tags: string;
  pageURL: string;
  user: string;
  previewURL: string;
  webformatURL: string;
  webformatWidth: number;
  webformatHeight: number;
  largeImageURL: string;
  imageWidth: number;
  imageHeight: number;
}

/**
 * Pixabay stock video and photos. The video endpoint has no orientation
 * filter, so for vertical videos the word "vertical" is added to the query
 * (most uploads shot in portrait carry that tag) and plain results follow as
 * a fallback to be cropped.
 */
export class PixabayProvider implements VisualProvider {
  readonly id = "pixabay";
  readonly credit = { label: "Pixabay", url: "https://pixabay.com/" };
  readonly kinds = ["video", "image"] as const;
  private readonly fetch: Fetch;
  private readonly now: () => number;

  constructor(private readonly options: Options) {
    this.fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.now = options.now ?? Date.now;
  }

  async search(request: VisualSearchRequest): Promise<VisualCandidate[]> {
    const query = request.query.trim().replace(/\s+/g, " ");
    if (!query) return [];
    const perPage = Math.min(200, Math.max(3, request.limit));

    if (request.kind === "image") {
      const hits = await this.get<ImageHit>("", {
        q: query.slice(0, MAX_QUERY_CHARS),
        image_type: "photo",
        orientation: request.format,
        per_page: String(perPage),
      }, request.signal);
      return hits.map((hit) => ({ ...imageCandidate(hit), relevance: relevance(query, hit.tags) }));
    }

    const plain = await this.videos(query, query, perPage, request.signal);
    if (request.format !== "vertical") return plain;
    // Portrait uploads first, then everything else (landscape gets cropped); the caller ranks them.
    const portrait = (await this.videos(`${query} vertical`, query, perPage, request.signal)).filter((c) => c.height > c.width);
    const seen = new Set(portrait.map((c) => c.id));
    return [...portrait, ...plain.filter((c) => !seen.has(c.id))];
  }

  private async videos(search: string, query: string, perPage: number, signal?: AbortSignal): Promise<VisualCandidate[]> {
    const hits = await this.get<VideoHit>("videos/", {
      q: search.slice(0, MAX_QUERY_CHARS),
      video_type: "film",
      per_page: String(perPage),
    }, signal);
    return hits.flatMap((hit) => {
      const candidate = videoCandidate(hit);
      return candidate ? [{ ...candidate, relevance: relevance(query, hit.tags) }] : [];
    });
  }

  /** One API call, served from the 24 h disk cache when possible. */
  private async get<T>(endpoint: string, params: Record<string, string>, signal?: AbortSignal): Promise<T[]> {
    const search = new URLSearchParams({ ...params, safesearch: "true" });
    search.sort();
    const cacheFile = path.join(
      this.options.cacheDir,
      `pixabay-${createHash("sha1").update(`${endpoint}?${search}`).digest("hex")}.json`,
    );
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, "utf8")) as { at: number; hits: T[] };
      if (this.now() - cached.at < CACHE_TTL_MS) return cached.hits;
    } catch {
      // Not cached (or unreadable): ask the API.
    }

    let response: Response;
    try {
      response = await this.fetch(`${API}${endpoint}?${search}&key=${encodeURIComponent(this.options.apiKey)}`, { signal });
    } catch (error) {
      throw new PipelineError("visuals", translate("Could not be connected to Pixabay: {0}", error instanceof Error ? error.message : error), {
        retryable: true,
        cause: error,
      });
    }
    if (!response.ok) {
      const body = (await response.text().catch(() => "")).slice(0, 300);
      const hint = response.status === 429 ? translate(" (limit of 100 searches per minute; wait a minute)") : "";
      throw new PipelineError("visuals", `Pixabay ${response.status}: ${body || response.statusText}${hint}`, {
        retryable: response.status === 429 || response.status >= 500,
      });
    }
    const json = (await response.json()) as { hits?: T[] };
    const hits = json.hits ?? [];
    fs.mkdirSync(this.options.cacheDir, { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify({ at: this.now(), hits }));
    return hits;
  }
}

/**
 * Share of the query's words that appear in the asset's tags. Pixabay matches
 * loosely (any word, synonyms), so a search for salt crystals can return a
 * dog; the tags tell which results are really about the query.
 */
export function relevance(query: string, tags: string): number {
  const stem = (word: string) => (word.length > 4 ? word.replace(/(ing|es|s)$/, "") : word);
  const words = query.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2).map(stem);
  if (words.length === 0) return 1;
  const text = tags.toLowerCase();
  return words.filter((w) => text.includes(w)).length / words.length;
}

function videoCandidate(hit: VideoHit): VisualCandidate | null {
  const files: VisualFile[] = ["tiny", "small", "medium", "large"]
    .map((name) => hit.videos[name])
    .filter((v): v is NonNullable<typeof v> => !!v && !!v.url && v.width > 0 && v.height > 0)
    .map((v) => ({ url: v.url, width: v.width, height: v.height, size: v.size }));
  if (files.length === 0) return null;
  const best = files.at(-1)!;
  return {
    provider: "pixabay",
    id: `v${hit.id}`,
    kind: "video",
    width: best.width,
    height: best.height,
    durationSec: hit.duration,
    thumbUrl: (hit.videos.tiny ?? hit.videos.small ?? hit.videos.medium)?.thumbnail ?? "",
    files,
    pageUrl: hit.pageURL,
    author: hit.user,
  };
}

function imageCandidate(hit: ImageHit): VisualCandidate {
  // largeImageURL is at most 1280 px on its long side.
  const scale = 1280 / Math.max(hit.imageWidth, hit.imageHeight, 1);
  const large = {
    url: hit.largeImageURL,
    width: Math.round(hit.imageWidth * Math.min(1, scale)),
    height: Math.round(hit.imageHeight * Math.min(1, scale)),
  };
  return {
    provider: "pixabay",
    id: `i${hit.id}`,
    kind: "image",
    width: large.width,
    height: large.height,
    durationSec: null,
    thumbUrl: hit.previewURL,
    files: [{ url: hit.webformatURL, width: hit.webformatWidth, height: hit.webformatHeight }, large],
    pageUrl: hit.pageURL,
    author: hit.user,
  };
}

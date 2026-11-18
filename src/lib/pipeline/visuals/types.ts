import type { VideoFormat, VisualCandidate, VisualKind } from "@/lib/domain";

export interface VisualSearchRequest {
  /** English search phrase (or, for a generative provider, the prompt). */
  query: string;
  kind: VisualKind;
  /** Target frame: providers favour assets that fill it without cropping. */
  format: VideoFormat;
  /** How many candidates are wanted at most. */
  limit: number;
  signal?: AbortSignal;
}

/**
 * B-roll source: query -> candidates with downloadable files. Stock libraries
 * search; an AI image/video provider would generate `limit` assets from the
 * query and return them the same way (its `files` pointing at what it made),
 * so the rest of the pipeline (selection, normalization, cache, composition,
 * picker UI) does not change.
 */
export interface VisualProvider {
  /** Stable id stored on every candidate, e.g. "pixabay". */
  readonly id: string;
  /** Name and link shown wherever its results are displayed. */
  readonly credit: { label: string; url: string };
  readonly kinds: readonly VisualKind[];
  search(request: VisualSearchRequest): Promise<VisualCandidate[]>;
}

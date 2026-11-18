import { env } from "@/lib/env";
import { storagePaths } from "@/lib/storage";
import { PixabayProvider } from "./pixabay";
import type { VisualProvider } from "./types";

export type { VisualProvider, VisualSearchRequest } from "./types";

/**
 * The b-roll provider the app uses, or null when none is configured (scenes
 * then keep the animated background). Swap or add implementations here, e.g.
 * an AI image provider behind the same interface.
 */
export function getVisualProvider(): VisualProvider | null {
  const apiKey = env().PIXABAY_API_KEY;
  if (!apiKey) return null;
  return new PixabayProvider({ apiKey, cacheDir: storagePaths.searchCache() });
}

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { storagePaths } from "@/lib/storage";
import { editClipSchema, overlaySchema } from "./schema";
import type { NoteReview } from "./notes";

const reviewSchema = z.object({
  revision: z.number().int().nonnegative(),
  range: z.object({ from: z.number().min(0).max(7200), to: z.number().min(0).max(7200) }).optional(),
  changes: z.array(z.object({
    kind: z.enum(["clip", "overlay"]), id: z.string(),
    before: z.union([editClipSchema, overlaySchema]).optional(),
    after: z.union([editClipSchema, overlaySchema]).optional(),
    fields: z.array(z.string()),
  })),
  times: z.array(z.number().finite().min(0).max(7200)),
  reviewed: z.array(z.number().int().nonnegative()),
  unavailable: z.array(z.number().int().nonnegative()),
});
const reviewPath = (projectId: string) => path.join(/*turbopackIgnore: true*/ storagePaths.project(projectId), "analysis", "edit-note-review.json");

/** Review progress is independent of the montage and survives a stopped turn or app restart. */
export function readNoteReview(projectId: string): NoteReview | undefined {
  try {
    const saved = reviewSchema.parse(JSON.parse(fs.readFileSync(reviewPath(projectId), "utf8")));
    return { ...saved, reviewed: new Set(saved.reviewed), unavailable: new Set(saved.unavailable) };
  } catch { return undefined; }
}

export function saveNoteReview(projectId: string, review: NoteReview): void {
  const file = reviewPath(projectId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify({ ...review, reviewed: [...review.reviewed], unavailable: [...review.unavailable] }));
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

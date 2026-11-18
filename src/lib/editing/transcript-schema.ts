import { z } from "zod";

/**
 * What the montage keeps about editing from the transcript: the project's dictionary of names and terms
 * (applied to every subtitle) and the cuts the assistant proposed for the user to review. Word timings
 * themselves live in the analysis cache (one file per source), not in the document.
 */

const seconds = z.number().finite().min(0).max(7200);

/** Word timings of a source file, as the transcription writes them (seconds of the file). */
export const transcriptWordsSchema = z.array(z.object({
  id: z.string().max(40).optional(),
  text: z.string().max(200),
  start: z.number().finite().min(0),
  end: z.number().finite().min(0),
})).transform((words) => words.flatMap((w, i) => w.text.trim() ? [{ id: w.id || `w${i}`, text: w.text.trim(), start: w.start, end: Math.max(w.start, w.end) }] : []));

/** «Se oye» → «Se escribe»: what the recogniser wrote and how it must read in the subtitles. */
export const transcriptCorrectionSchema = z.object({
  from: z.string().trim().min(1).max(120),
  /** Empty hides those words from the subtitles (a stray symbol, a doubled word); the audio is not cut. */
  to: z.string().trim().max(120),
});
export type TranscriptCorrection = z.infer<typeof transcriptCorrectionSchema>;

export const TRANSCRIPT_CUT_KINDS = ["pause", "retake", "filler", "phrase"] as const;
export type TranscriptCutKind = (typeof TRANSCRIPT_CUT_KINDS)[number];

/** A cut waiting for the user's approval: a span of words (or a pause) of one source file. */
export const transcriptProposalSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  assetId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  kind: z.enum(TRANSCRIPT_CUT_KINDS),
  /** Source seconds of the stretch to remove, before margins. */
  from: seconds,
  to: seconds,
  /** The words it removes, as read (empty for a pause). */
  text: z.string().max(600),
  /** Why it goes: shown to the user next to the proposal. */
  reason: z.string().max(400),
  /** Ticked in the review list when it opens; doubtful ones (a «pues» that may carry meaning) start unticked. */
  preselect: z.boolean().optional(),
}).refine((p) => p.to > p.from, "The proposed cut must last for something.");
export type TranscriptProposal = z.infer<typeof transcriptProposalSchema>;

/** Subtitles with their keywords in a colour: chosen by the assistant (`words`) or found automatically. */
export const captionHighlightSchema = z.object({
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  words: z.array(z.string().trim().min(1).max(80)).max(80).optional(),
});
export type CaptionHighlight = z.infer<typeof captionHighlightSchema>;

export const transcriptStateSchema = z.object({
  corrections: z.array(transcriptCorrectionSchema).max(300).default([]),
  proposals: z.array(transcriptProposalSchema).max(400).default([]),
  highlight: captionHighlightSchema.optional(),
});
export type TranscriptState = z.infer<typeof transcriptStateSchema>;

import { t as translate } from "@/lib/i18n";
import fs from "node:fs/promises";
import path from "node:path";
import { getProject } from "@/lib/projects";
import { alignWords } from "@/lib/pipeline/alignment";
import { getCachedTts, type CachedTts } from "@/lib/pipeline/tts";
import type { WordTiming } from "@/lib/domain";
import { importMedia } from "./media";
import { saveEditDocument } from "./repository";
import { groupCaptionWords, highlightCaptions } from "./transcript";
import { captionAppearanceSchema, isNarrationName, newOverlay, VOICEOVER_PREFIX, type CaptionAppearance, type EditClip, type EditDocument, type EditOverlay } from "./schema";

/** Files made by the voice-over are named like this, so a new take can replace the previous one. */
export { VOICEOVER_PREFIX };
/** Track of the voice under the music (audio track 0). */
const VOICE_TRACK = 1;
/** Music level under a voice: present, never covering the words. */
const MUSIC_UNDER_VOICE = 0.22;

export interface VoiceoverLine {
  text: string;
  /** Second of the montage where this line starts. */
  start: number;
}

export interface VoiceoverResult {
  edit: EditDocument;
  /** When the last line ends, in montage seconds. */
  end: number;
  lines: number;
  captions: number;
  /** Lines that would overlap the next one: they were pushed later. */
  shifted: number;
}

/**
 * Narrates a montage: each line is spoken by the project's voice (through the TTS cache, so retakes of the
 * same words are free), imported as an audio file and placed at its second on its own track. Optional
 * captions follow the spoken words; music under the voice is lowered. A new voice-over replaces the old one.
 */
export async function addVoiceover(projectId: string, voiceId: string, lines: VoiceoverLine[], options: { captions?: boolean; captionAppearance?: Partial<CaptionAppearance>; wordsPerCue?: number; tts?: CachedTts } = {}): Promise<VoiceoverResult> {
  const tts = options.tts ?? getCachedTts();
  const ordered = [...lines].sort((a, b) => a.start - b.start);
  const takes: { line: VoiceoverLine; file: string; words: WordTiming[] }[] = [];
  for (const line of ordered) {
    const text = line.text.trim();
    const audio = await tts.get({ text, voiceId });
    takes.push({ line: { ...line, text }, file: audio.audioPath, words: alignWords(text, audio.alignment) });
  }

  // Import every take first; each import saves the montage, so the placement below starts from the latest one.
  const imported: { line: VoiceoverLine; assetId: string; duration: number; words: WordTiming[] }[] = [];
  for (const [i, take] of takes.entries()) {
    const name = `${VOICEOVER_PREFIX}${i + 1}${path.extname(take.file) || ".mp3"}`;
    const edit = await importMedia(projectId, new File([await fs.readFile(take.file)], name));
    const asset = edit.assets.at(-1)!;
    imported.push({ line: take.line, assetId: asset.id, duration: asset.duration, words: take.words });
  }

  const p = getProject(projectId);
  if (!p) throw new Error(translate("The project no longer exists."));
  const doc = p.edit;
  const fresh = new Set(imported.map((t) => t.assetId));
  const voiceAssets = new Set(doc.assets.filter((a) => a.kind === "audio" && isNarrationName(a.name) && !fresh.has(a.id)).map((a) => a.id));
  const oldVoice = doc.clips.filter((c) => voiceAssets.has(c.assetId));
  const overlapsOld = (o: EditOverlay) => oldVoice.some((c) => o.start < c.start + c.duration && o.start + o.duration > c.start);

  // Lines never talk over each other: a line that would start before the previous one ends waits for it.
  let cursor = 0, shifted = 0;
  const placed = imported.map((t) => {
    const start = Math.max(t.line.start, cursor);
    if (start > t.line.start + 0.01) shifted++;
    cursor = start + t.duration + 0.15;
    return { ...t, start };
  });
  const voiceClips: EditClip[] = placed.map((t) => ({ id: crypto.randomUUID(), assetId: t.assetId, start: round(t.start), in: 0, duration: t.duration, volume: 1, fit: "contain", transition: "cut", motion: "none", track: VOICE_TRACK }));

  const style = doc.overlays.find((o) => o.kind === "caption");
  const captions = options.captions !== true ? [] : placed.flatMap((t) => captionCues(t.words, t.start, t.duration, options.wordsPerCue)).map((cue) => ({
    ...newOverlay(cue.text, round(cue.start), round(cue.duration), "caption"),
    ...(style ? captionAppearanceSchema.parse(style) : {}),
    ...options.captionAppearance,
  }));

  const musicAssets = new Set(doc.assets.filter((a) => a.kind === "audio" && !isNarrationName(a.name)).map((a) => a.id));
  const next: EditDocument = {
    ...doc,
    enabled: true,
    clips: [...doc.clips.filter((c) => !voiceAssets.has(c.assetId)).map((c) => musicAssets.has(c.assetId) ? { ...c, volume: Math.min(c.volume, MUSIC_UNDER_VOICE) } : c), ...voiceClips],
    overlays: captions.length ? [...doc.overlays.filter((o) => o.kind !== "caption" || !overlapsOld(o)), ...captions] : doc.overlays.filter((o) => o.kind !== "caption" || !overlapsOld(o)),
  };
  const edit = saveEditDocument(projectId, captions.length ? highlightCaptions(next) : next, true);
  const last = placed.at(-1)!;
  return { edit, end: round(last.start + last.duration), lines: placed.length, captions: captions.length, shifted };
}

/** Spoken words in short caption cues that read as phrases (the rule of transcript.ts, shared with imported footage), offset to the montage. */
function captionCues(words: WordTiming[], offset: number, fallbackDuration: number, wordsPerCue = 4): { text: string; start: number; duration: number }[] {
  const cues = groupCaptionWords(words.map((w) => ({ text: w.text, start: offset + w.start, end: offset + w.end })), wordsPerCue)
    .map((c) => ({ text: c.text, start: c.start, duration: Math.max(0.3, c.end - c.start) }));
  // No timings from the provider: one cue for the whole line.
  if (!cues.length && words.length === 0) return [];
  return cues.length ? cues : [{ text: words.map((w) => w.text).join(" "), start: offset, duration: fallbackDuration }];
}

const round = (n: number) => Math.round(n * 1000) / 1000;

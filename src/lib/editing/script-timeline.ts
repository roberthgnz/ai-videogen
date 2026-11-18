import { t as translate } from "@/lib/i18n";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { FORMAT_SIZE, type CaptionStyleId, type SceneContent, type TransitionId, type VideoFormat, type WordTiming } from "@/lib/domain";
import { probeMedia } from "@/lib/media/ffprobe";
import { listSfx, prepareMusic, resolveMusic } from "@/lib/pipeline/audio/music";
import { compositionDuration, sceneSlots, sceneTransitions } from "@/lib/pipeline/composition";
import { captionGroupsForScenes, captionLimits, captionText } from "@/lib/pipeline/composition/captions";
import { errorMessage } from "@/lib/pipeline/errors";
import { expectedAudioHashes, runTtsForProject, sceneAudioStatus } from "@/lib/pipeline/steps/tts";
import { candidateKey, readyShots, runVisualsForProject } from "@/lib/pipeline/steps/visuals";
import { getCachedTts, type CachedTts } from "@/lib/pipeline/tts";
import { shotFilePath } from "@/lib/pipeline/visuals/media";
import { planShots, sceneWordStarts } from "@/lib/pipeline/visuals/shots";
import { getProject } from "@/lib/projects";
import { ensureDir, resolveInStorage, storagePaths, toStorageRelative } from "@/lib/storage";
import { STYLE_PRESETS, themeForPreset } from "@/presets";
import type { Theme } from "@/theme";
import { seedFootage } from "./footage";
import { MUSIC_VOLUME_UNDER_SPEECH } from "./music";
import { saveEditDocument } from "./repository";
import { MIN_CAPTION, newOverlay, referenceAssetIds, VOICEOVER_PREFIX, type CaptionAppearance, type EditAsset, type EditClip, type EditDocument, type EditOverlay } from "./schema";
import { textBox } from "./text-preview";
import { registerGlobalAsset } from "../global-assets";

/**
 * A script on the timeline instead of in a rendered MP4: every b-roll shot, every scene's voice, the
 * subtitles, the on-screen texts, the music and the transition effects as separate elements on their own
 * tracks, at the times the rendered video would have them. The user plays it, moves, cuts or swaps what
 * they do not like, and only then exports.
 */

/** Audio tracks: the music bed, the narration over it, the transition effects. */
const MUSIC_TRACK = 0;
const VOICE_TRACK = 1;
const SFX_TRACK = 2;

/** Ids of the files this step puts in the library. The same source always gets the same id, so building again reuses them. */
const GENERATED = "guion-";
const generatedId = (kind: string, key: string) => `${GENERATED}${kind}-${createHash("sha1").update(key).digest("hex").slice(0, 16)}`;

/** Whether the montage holds a script laid out by this step (so the script's settings only reach it by building again). */
export const hasScriptTimeline = (doc: Pick<EditDocument, "clips">) => doc.clips.some((c) => c.assetId.startsWith(GENERATED));

const round = (n: number) => Math.round(n * 1000) / 1000;

type Look = Pick<EditOverlay, "x" | "y" | "width" | "fontSize" | "color" | "background" | "align">;

export interface TimelineScene {
  content: SceneContent;
  words: WordTiming[];
  audioDurationSec: number;
  /** Id of the file with its voice. */
  voice: string;
  /** Ids of its b-roll files, in shot order. */
  shots: string[];
}

export interface TimelineInput {
  format: VideoFormat;
  captionStyle: CaptionStyleId;
  transition: TransitionId;
  theme: Theme;
  /** Colours of the scene titles: the preset's accent and the text drawn on it. */
  accent: string;
  onAccent: string;
  scenes: TimelineScene[];
  /** The files in the library, by id. An id that is not here is left out. */
  assets: Map<string, EditAsset>;
  music?: string;
  /** Transition effects, used in rotation. */
  sfx: string[];
  captions?: boolean;
  titles?: boolean;
  captionAppearance?: Partial<CaptionAppearance>;
  textAppearance?: Partial<CaptionAppearance>;
  wordsPerCue?: number;
}

/** One size for every subtitle: the style's, shrunk until the longest one fits on one line above what the social apps cover. */
function captionLook(texts: string[], size: number, uppercase: boolean, format: VideoFormat): Look {
  const { width, height } = FORMAT_SIZE[format];
  const box = 84;
  const longest = Math.max(1, ...texts.map((t) => t.length));
  // The canvas font takes about this many em per character, plus the box's own padding.
  const fit = Math.floor(((box / 100) * width) / ((uppercase ? 0.7 : 0.58) * longest + 0.6));
  const fontSize = Math.max(36, Math.min(size, fit, 200));
  const boxHeight = ((fontSize * 1.78) / height) * 100;
  return { x: (100 - box) / 2, y: Math.round((format === "vertical" ? 79 : 92) - boxHeight), width: box, fontSize, color: "#ffffff", background: "#101018", align: "center" };
}

/** A scene's on-screen text: its first line as the title, the rest (bullets included) under it. */
function sceneText(content: SceneContent): { head: string; body: string } {
  let head = "";
  const lines: string[] = [];
  for (const value of Object.values(content)) {
    if (Array.isArray(value)) lines.push(...value.filter((v) => typeof v === "string" && v.trim()).map((v) => `• ${v.trim()}`));
    else if (typeof value === "string" && value.trim()) {
      if (head) lines.push(value.trim());
      else head = value.trim();
    }
  }
  return { head, body: lines.join("\n") };
}

/**
 * Where everything goes. Pure: scenes last what their voice lasts (plus the pauses of the theme), as in
 * the rendered video; shots are cut on word starts; subtitles follow the spoken words.
 */
export function layoutScriptTimeline(input: TimelineInput): { clips: EditClip[]; overlays: EditOverlay[]; duration: number } {
  const { theme, format } = input;
  const slots = sceneSlots(input.scenes.map((s) => s.audioDurationSec), theme);
  const duration = compositionDuration(input.scenes.map((s) => s.audioDurationSec), theme);
  const transitions = sceneTransitions(input.scenes.length, input.transition);
  const clip = (assetId: string, start: number, length: number, extra: Partial<EditClip> = {}): EditClip =>
    ({ id: crypto.randomUUID(), assetId, start: round(start), in: 0, duration: round(length), volume: 1, fit: "cover", transition: "cut", motion: "none", ...extra });

  // Picture: the main video track, back to back. Each shot starts where the previous one ends, to the millisecond.
  const picture: EditClip[] = [];
  let cursor = 0;
  input.scenes.forEach((scene, i) => {
    const slot = slots[i];
    const files = scene.shots.map((id) => input.assets.get(id)).filter((a): a is EditAsset => !!a);
    if (!files.length) return;
    // A scene without pictures before this one leaves its gap; otherwise the track goes on from the last cut.
    if (Math.abs(cursor - slot.start) > 0.01) cursor = slot.start;
    const shots = planShots(slot.duration, sceneWordStarts(scene.words, slot.narrationStart), files.length);
    shots.forEach((shot, k) => {
      const asset = files[k];
      // The last shot ends exactly where the scene does, so the next scene's first clip touches it.
      const end = round(slot.start + (k === shots.length - 1 ? slot.duration : shot.start + shot.duration));
      const span = round(end - cursor);
      if (span < 0.04) return;
      // A stock clip shorter than its shot plays slower to fill it, rather than leaving the screen black.
      const usable = Math.max(0.04, asset.duration - 0.02);
      const speed = asset.kind === "image" || span <= usable ? undefined : Math.max(0.25, Math.floor((usable / span) * 1000) / 1000);
      picture.push(clip(asset.id, cursor, asset.kind === "image" ? span : Math.min(span, usable / (speed ?? 1)), {
        // The scene change arrives with the project's transition; cuts inside a scene are plain cuts.
        transition: k === 0 && i > 0 ? transitions[i - 1] ?? "cut" : "cut",
        motion: "none",
        ...(speed ? { speed } : {}),
        track: 0,
      }));
      cursor = end;
    });
  });

  // Sound. The music goes first among the audio clips: it is the one the music tools take.
  const audio: EditClip[] = [];
  const music = input.music ? input.assets.get(input.music) : undefined;
  if (music && music.duration >= 0.04) audio.push(clip(music.id, 0, Math.min(duration, music.duration), { volume: MUSIC_VOLUME_UNDER_SPEECH, fit: "contain", track: MUSIC_TRACK }));
  input.scenes.forEach((scene, i) => {
    const voice = input.assets.get(scene.voice);
    if (voice) audio.push(clip(voice.id, slots[i].start + slots[i].narrationStart, Math.min(scene.audioDurationSec, voice.duration), { fit: "contain", track: VOICE_TRACK }));
  });
  const effects = input.sfx.map((id) => input.assets.get(id)).filter((a): a is EditAsset => !!a && a.duration >= 0.04);
  let used = 0;
  transitions.forEach((kind, i) => {
    if (!kind || !effects.length) return;
    const effect = effects[used++ % effects.length];
    audio.push(clip(effect.id, Math.max(0, slots[i].start + slots[i].duration - theme.audio.sfxLead), effect.duration, { volume: theme.audio.sfxVolume, fit: "contain", track: SFX_TRACK }));
  });

  // On-screen texts: the scene's title on the accent colour and the rest under it, for as long as the scene lasts.
  const vertical = format === "vertical";
  const texts: EditOverlay[] = [];
  input.scenes.forEach((scene, i) => {
    const { head, body } = sceneText(scene.content);
    const slot = slots[i];
    let y = input.textAppearance?.y ?? (vertical ? 12 : 8);
    if (head && input.titles === true) {
      const title: EditOverlay = { ...newOverlay(head.slice(0, 1000), slot.start, slot.duration, "text"), x: 8, y, width: 84, fontSize: vertical ? 68 : 60, color: input.onAccent, background: input.accent, ...input.textAppearance, track: 0 };
      texts.push(title);
      y = Math.round((y + textBox(title, vertical).h + 1) * 10) / 10;
    }
    if (body && input.titles === true) texts.push({ ...newOverlay(body.slice(0, 1000), slot.start, slot.duration, "text"), x: 8, width: 84, fontSize: vertical ? 44 : 38, ...input.textAppearance, y: Math.min(y, 90), track: 1 });
  });

  // Subtitles: the same groups of words the rendered captions show, one element per group.
  const style = theme.captions.styles[input.captionStyle];
  const uppercase = !input.captionAppearance && style.uppercase;
  const limits = captionLimits(theme, input.captionStyle, format);
  const cues = captionGroupsForScenes(
    input.scenes.map((s, i) => ({ start: slots[i].start, narrationStart: slots[i].start + slots[i].narrationStart, end: slots[i].start + slots[i].duration, words: s.words })),
    input.wordsPerCue ?? limits.maxWords,
    limits.maxChars,
  ).map((group) => {
    const text = group.words.map((w) => captionText(w.text, input.captionAppearance ? false : style.stripPunctuation)).join(" ").trim();
    return { text: (uppercase ? text.toLocaleUpperCase("es") : text).slice(0, 1000), start: group.start, duration: Math.max(MIN_CAPTION, round(group.end - group.start)) };
  }).filter((cue) => cue.text);
  const look = captionLook(cues.map((c) => c.text), style.size[format], uppercase, format);
  const captions = input.captions !== true ? [] : cues.map((cue): EditOverlay => ({ ...newOverlay(cue.text, cue.start, cue.duration, "caption"), ...look, ...input.captionAppearance, track: 0 }));

  return { clips: [...picture, ...audio], overlays: [...texts, ...captions], duration };
}

interface Source {
  id: string;
  name: string;
  kind: "video" | "audio" | "image";
  /** Absolute path of the file to copy into the project. */
  file: string;
  context: string;
  /** What a stock clip shows, for the footage log. */
  footage?: string;
  /** The montage is still worth building without it (music, effects). */
  optional?: boolean;
}

/** Copies a file into the project's media folder (once) and measures it: a library entry like an imported one. */
async function register(projectId: string, source: Source): Promise<EditAsset> {
  const ext = path.extname(source.file).toLowerCase() || (source.kind === "video" ? ".mp4" : source.kind === "audio" ? ".mp3" : ".jpg");
  const file = path.join(ensureDir(path.join(storagePaths.project(projectId), "media", source.id)), `media${ext}`);
  try { await fs.access(file); } catch { await fs.copyFile(source.file, file); }
  const info = await probeMedia(file, source.kind === "image");
  const stream = info.streams.find((s) => s.type === "video");
  const asset: EditAsset = { id: source.id, name: source.name.slice(0, 240), kind: source.kind, path: toStorageRelative(file), duration: source.kind === "image" ? 0 : info.durationSec,
    width: stream?.width ?? 0, height: stream?.height ?? 0, hasAudio: info.streams.some((s) => s.type === "audio"), context: source.context.slice(0, 16000) };
  try {
    registerGlobalAsset({
      id: asset.id,
      name: asset.name,
      kind: asset.kind,
      source: source.kind === "audio" ? "generated" : "stock",
      path: asset.path,
      duration: asset.duration,
      width: asset.width,
      height: asset.height,
      hasAudio: asset.hasAudio,
      context: asset.context,
      projectId,
    });
  } catch { /* ignore non-blocking registration */ }
  return asset;
}

export interface ScriptTimelineResult {
  edit: EditDocument;
  /** Length of the montage, seconds. */
  duration: number;
  shots: number;
  voices: number;
  captions: number;
  texts: number;
  /** Name of the music track, or null when there is none. */
  music: string | null;
  /** When each scene is on screen and when its voice starts, in montage seconds: where a picture made for it goes. */
  slots: { start: number; duration: number; voiceStart: number }[];
  /** What could not be done, in words for the user. */
  notes: string[];
}

/**
 * Builds the montage of a script: the voice that is missing (cached audio is free), the b-roll chosen
 * for every shot (downloaded once), the music cut to length, and everything laid on the timeline.
 * It REPLACES the clips and texts of the montage; the user's files and references stay in the library.
 * Nothing is rendered. With `stock: false` no b-roll is searched or placed: the picture track stays empty
 * for the graphics the agent draws for each scene.
 */
export async function buildScriptTimeline(projectId: string, options: { tts?: CachedTts; signal?: AbortSignal; direction?: NonNullable<EditDocument["direction"]>; stock?: boolean } = {}): Promise<ScriptTimelineResult> {
  const before = getProject(projectId);
  if (!before) throw new Error(translate("Project not found."));
  if (!before.scenes.length) throw new Error(translate("The project has no script: write it before you ride it."));
  const direction = options.direction ?? before.edit.direction ?? { voiceover: before.scenes.some((s) => !!s.audioPath), captions: false, titles: false, music: false, sfx: false };
  if (direction.voiceover && !before.voiceId) throw new Error(translate("Choose a voice before you mount the timeline."));
  const notes: string[] = [];

  if (direction.voiceover) {
    const voiced = await runTtsForProject(projectId, { tts: options.tts ?? getCachedTts() });
    if (!voiced.ok) throw new Error(voiced.error ?? translate("Voice generation failed."));
  }
  const withStock = options.stock !== false;
  let noProvider = false;
  if (withStock) {
    const visuals = await runVisualsForProject(projectId, { download: true, signal: options.signal });
    if (!visuals.ok) throw new Error(visuals.error);
    noProvider = !!visuals.skipped;
    if (noProvider) notes.push(translate("There is no set-up b-roll supplier: the assembly goes without stock images."));
  }

  const p = getProject(projectId);
  if (!p) throw new Error(translate("The project no longer exists."));
  const hashes: Record<string, string | null> = direction.voiceover ? expectedAudioHashes(p.scenes, p.voiceId, options.tts ?? getCachedTts()) : {};
  const unvoiced = direction.voiceover ? p.scenes.flatMap((s, i) => (sceneAudioStatus(s, hashes[s.id]) === "ready" && s.audioPath && s.audioDurationSec ? [] : [i + 1])) : [];
  if (unvoiced.length) throw new Error(translate("The voice of {0} {1} is missing. Wait for it to end and reassemble.", unvoiced.length === 1 ? translate("the scene") : translate("the scenes"), unvoiced.join(", ")));

  const { format } = p;
  const theme = themeForPreset(p.preset);
  const sources = new Map<string, Source>();
  const wordCounts = p.scenes.map((s) => Math.max(1, s.narration.trim().split(/\s+/).length));
  const totalWords = wordCounts.reduce((sum, n) => sum + n, 0);
  const imageTime = Math.max(p.scenes.length * 0.1, p.targetDurationSec - p.scenes.length * (theme.timing.sceneLead + theme.timing.sceneTail));
  const scenes: TimelineScene[] = p.scenes.map((scene, i) => {
    const voice = direction.voiceover ? generatedId("voz", scene.audioHash!) : "";
    if (voice && !sources.has(voice)) sources.set(voice, { id: voice, name: `${VOICEOVER_PREFIX}${i + 1}${path.extname(scene.audioPath!) || ".mp3"}`, kind: "audio", file: resolveInStorage(scene.audioPath!), context: translate("Voice of the {0} scene of the script: \"{1}\"", i + 1, scene.narration.trim()) });
    const shots = (withStock ? readyShots(scene, format) : []).map((candidate) => {
      const id = generatedId("plano", `${candidateKey(candidate)}|${format}`);
      const query = scene.shots?.find((s) => s.selected && candidateKey(s.selected) === candidateKey(candidate))?.query.trim() ?? "";
      const what = translate("B-roll stock scene {0} {1}", i + 1, query ? `, buscado como «${query}»` : "");
      if (!sources.has(id)) sources.set(id, { id, name: translate("Scene {0} · {1}", i + 1, query || "b-roll"), kind: candidate.kind, file: shotFilePath(candidate, format), context: `${what}.`, footage: what });
      return id;
    });
    return { content: scene.content, words: direction.voiceover ? scene.words ?? [] : [], audioDurationSec: direction.voiceover ? scene.audioDurationSec! : imageTime * wordCounts[i] / totalWords, voice, shots };
  });
  const bare = scenes.filter((s) => !s.shots.length).length;
  // Without a provider the note above already says so; without stock by choice nothing is missing.
  if (bare && withStock && !noProvider) notes.push(translate("{0} without images: search b-roll for {1} or add yours.", bare === 1 ? translate("A scene has stayed") : translate("{0} scenes have stayed", bare), bare === 1 ? "ella" : "ellas"));

  let music: string | undefined;
  const track = direction.music ? resolveMusic(p.music, projectId) : null;
  if (track) {
    try {
      const file = await prepareMusic(track, compositionDuration(scenes.map((s) => s.audioDurationSec), theme), options.signal);
      music = generatedId("musica", path.basename(file));
      sources.set(music, { id: music, name: track, kind: "audio", file, context: translate("Background music chosen in the project settings, cut to the duration of the script."), optional: true });
    } catch (error) {
      notes.push(translate("The music could not be prepared: {0}", errorMessage(error)));
    }
  }
  const sfx: string[] = [];
  if (p.sfx && direction.sfx) {
    const changes = sceneTransitions(scenes.length, p.transition).filter(Boolean).length;
    for (const name of listSfx().slice(0, changes)) {
      const file = path.join(storagePaths.sfx(), name);
      const size = await fs.stat(file).then((s) => s.size, () => 0);
      const id = generatedId("efecto", `${name}|${size}`);
      sources.set(id, { id, name: `Efecto · ${name}`, kind: "audio", file, context: translate("Sound effect of a scene change."), optional: true });
      sfx.push(id);
    }
  }

  const assets = new Map<string, EditAsset>();
  for (const source of sources.values()) {
    try {
      const asset = await register(projectId, source);
      assets.set(asset.id, asset);
      if (source.footage) await seedFootage(projectId, asset, source.footage);
    } catch (error) {
      if (!source.optional) throw new Error(translate("Could not prepare \"{0}\": {1}", source.name, errorMessage(error)));
      notes.push(translate("It could not be added \"{0}.\"", source.name));
    }
  }
  if (music && !assets.has(music)) music = undefined;

  // The montage as it is now, after the slow part: the user's own files and references stay; files of an earlier build that are no longer used go.
  const current = getProject(projectId)?.edit;
  if (!current) throw new Error(translate("The project no longer exists."));
  const guides = referenceAssetIds(current);
  const kept = current.assets.filter((a) => !assets.has(a.id) && (!a.id.startsWith(GENERATED) || guides.has(a.id)));
  const preset = STYLE_PRESETS[p.preset] ?? STYLE_PRESETS.viral;
  const referenceText = current.references.find((r) => r.roles.includes("style") && r.analysis)?.analysis?.text;
  const { clips, overlays, duration } = layoutScriptTimeline({ format, captionStyle: p.captionStyle, transition: p.transition, theme, accent: preset.accent, onAccent: preset.onAccent, scenes, assets, music, sfx, captions: direction.captions, titles: direction.titles, captionAppearance: referenceText?.appearance, textAppearance: referenceText?.appearance, wordsPerCue: referenceText?.wordsPerCue });
  const edit = saveEditDocument(projectId, { ...current, enabled: true, direction, duration, assets: [...kept, ...assets.values()], clips, overlays }, true);
  const kindOf = (c: EditClip) => assets.get(c.assetId)?.kind;
  return {
    edit,
    duration,
    shots: clips.filter((c) => kindOf(c) !== "audio").length,
    voices: direction.voiceover ? scenes.length : 0,
    captions: overlays.filter((o) => o.kind === "caption").length,
    texts: overlays.filter((o) => o.kind === "text").length,
    music: music ? track : null,
    slots: sceneSlots(scenes.map((s) => s.audioDurationSec), theme).map((slot) => ({ start: slot.start, duration: slot.duration, voiceStart: round(slot.start + slot.narrationStart) })),
    notes,
  };
}

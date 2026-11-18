import { t as translate } from "@/lib/i18n";
import { z } from "zod";
import { getProject, type ProjectWithRelations } from "@/lib/projects";
import { saveEditDocument } from "@/lib/editing/repository";
import { editDuration, referenceAssetIds, type EditAsset } from "@/lib/editing/schema";
import { transcriptCorrectionSchema, type TranscriptProposal } from "@/lib/editing/transcript-schema";
import { transcriptEnergy, transcriptPauses, transcriptWords } from "@/lib/editing/transcript-store";
import { DEFAULT_ACCENT } from "@/lib/editing/emphasis";
import {
  applyCuts, captionsCorrected, CUT_MARGIN, cutSeconds, DEFAULT_PAUSE, describeTranscript, newProposal, placeWords, proposalCut, proposalsFor,
  removeWords, restoreWords, saveProposals, setCorrections, setHighlight, suggestCleanup, transcriptState, wordSpan, type AudioEnergy, type WordTiming,
} from "@/lib/editing/transcript";
import type { AgentContext, AgentTool } from "./tools";

/**
 * Editing the montage from what is said: read the transcript with its timings, propose cuts for the user to
 * review, apply the approved ones, put words back and keep the dictionary of names. The craft of when to
 * propose and when to cut is in the `transcript-editing` skill.
 */

const tool = <S extends z.ZodObject>(def: AgentTool<S>): AgentTool<S> => def;
const where = "Subtitles › Words";
const CLEANUP_TAB = "Subtitles › Cleaning";
const NAMES_TAB = "Subtitles › Names";
const fmt = (n: number) => n.toFixed(2);
/** Seconds as the user reads them (a button shows a tool's result as is): «1,6 s». */
const secs = (n: number) => `${(Math.round(n * 10) / 10).toFixed(1).replace(".", ",")} s`;

function project(ctx: AgentContext): ProjectWithRelations {
  const found = getProject(ctx.projectId);
  if (!found) throw new Error(translate("The project no longer exists."));
  return found;
}

/** Files with sound that are in the montage, not references. */
function spokenFiles(p: ProjectWithRelations): EditAsset[] {
  const guides = referenceAssetIds(p.edit);
  return p.edit.assets.filter((a) => a.hasAudio && !guides.has(a.id) && p.edit.clips.some((c) => c.assetId === a.id));
}

function pickFile(p: ProjectWithRelations, assetId?: string): EditAsset {
  if (assetId) {
    const asset = p.edit.assets.find((a) => a.id === assetId);
    if (!asset) throw new Error(translate("Unfound file: use the \"Available Files\" id."));
    if (!asset.hasAudio) throw new Error(translate("\"{0}\" has no sound: no transcription.", asset.name));
    return asset;
  }
  const files = spokenFiles(p);
  if (files.length === 1) return files[0];
  if (!files.length) throw new Error(translate("There is no voice file in the assembly."));
  throw new Error(translate("There are several voice files in the assembly; it indicates assetId: {0}.", files.map((a) => `${a.name} (${a.id})`).join(", ")));
}

async function wordsOf(p: ProjectWithRelations, asset: EditAsset): Promise<WordTiming[]> {
  const words = await transcriptWords(p.id, asset.id, true);
  if (!words?.length) throw new Error(translate("No voice was recognized in \"{0}.\"", asset.name));
  return words;
}

/** The level of the file, which places each cut where the sound really stops; cuts work without it. */
const energyOf = (p: ProjectWithRelations, asset: EditAsset): Promise<AudioEnergy | undefined> => transcriptEnergy(p.id, asset.id).then((e) => e ?? undefined, () => undefined);

const proposalLine = (p: TranscriptProposal, seconds: number) => `${p.id} · ${p.kind} · ${fmt(p.from)}–${fmt(p.to)} s${p.text ? ` · «${p.text}»` : ""} · −${fmt(seconds)} s · ${p.reason}`;

const readTranscript = tool({
  name: "read_transcript",
  description: `Lee lo que se dice en un archivo del montaje, palabra a palabra con sus segundos: frases con sus números de palabra (#n) y tiempos en el archivo y en el montaje, lo que ya está quitado ([quitado: …]) y las pausas largas. Transcribe el archivo si hace falta (la primera vez tarda). Úsalo antes de proponer cortes, quitar frases o corregir nombres. detail="words" lista cada palabra; from/to (segundos del archivo) limita el tramo. Si hay un solo archivo con voz en el montaje, assetId es opcional.`,
  schema: z.object({
    assetId: z.string().optional(),
    from: z.number().min(0).optional(),
    to: z.number().min(0).optional(),
    detail: z.enum(["phrases", "words"]).default("phrases"),
  }),
  label: () => translate("Read the transcript"),
  run: async (input, ctx) => {
    const p = project(ctx);
    const asset = pickFile(p, input.assetId);
    const words = await wordsOf(p, asset);
    const doc = project(ctx).edit;
    const placed = placeWords(doc, asset.id, words);
    const state = transcriptState(doc);
    const pending = proposalsFor(doc, asset.id);
    const body = describeTranscript(doc, asset.id, words, input);
    return [
      translate("Transcript of \"{0}\"({1}): {2} words (# 0- #{3}), {4} in the assembly. Mounting: {5} s.", asset.name, asset.id, words.length, words.length - 1, placed.filter((w) => w.clipId).length, fmt(editDuration(doc))),
      state.corrections.length ? translate("Active name corrections (already applied to the text): {0}.", state.corrections.map((c) => `«${c.from}» → «${c.to || "(oculto)"}»`).join(", ")) : translate("No name fixes yet."),
      pending.length ? translate("Proposed cuts to be reviewed: {0} (ids: {1}).", pending.length, pending.map((x) => x.id).join(", ")) : "",
      translate("Automatic transcription may be wrong in own names, marks and technical terms."),
      body.length > 40000 ? `${body.slice(0, 40000)}\n… (recortado: pide un tramo con from/to)` : body,
    ].filter(Boolean).join("\n");
  },
});

const proposeTranscriptCuts = tool({
  name: "propose_transcript_cuts",
  description: `Suggest transcript cuts for review in ${CLEANUP_TAB}. The user can see the time saved, accept selected cuts, or ask you to apply them with apply_transcript_cuts. Use auto=true to suggest long pauses over minPause seconds, earlier takes, hesitations, and isolated fillers. Use cuts for your own proposals and cite word numbers (#n from read_transcript). Use kind "phrase" for unnecessary or off-topic speech, "retake" for a repeated or failed take, and "filler" for fillers. For a retake, identify the take to keep. Write a short reason in the studio language. Proposals replace earlier suggestions for the same file unless replace=false.`,
  schema: z.object({
    assetId: z.string().optional(),
    auto: z.boolean().default(false),
    minPause: z.number().min(0.2).max(3).default(DEFAULT_PAUSE),
    cuts: z.array(z.object({
      fromWord: z.number().int().min(0),
      toWord: z.number().int().min(0),
      kind: z.enum(["phrase", "retake", "filler"]),
      reason: z.string().min(3).max(300),
    })).max(80).default([]),
    replace: z.boolean().default(true),
  }),
  label: () => translate("Propose cuts from transcription"),
  run: async (input, ctx) => {
    const p = project(ctx);
    const asset = pickFile(p, input.assetId);
    const words = await wordsOf(p, asset);
    const energy = await energyOf(p, asset);
    const doc = project(ctx).edit;
    const texts = placeWords(doc, asset.id, words).map((w) => w.text);
    const own = input.cuts.map((c) => newProposal(asset.id, c.kind, words, wordSpan(words, c.fromWord, c.toWord), c.reason, texts));
    const auto = input.auto ? suggestCleanup(doc, asset.id, words, { minPause: input.minPause, energy, silences: await transcriptPauses(p.id, asset.id, Math.min(0.3, input.minPause)).catch(() => []) }) : [];
    // A word proposal of yours wins over an automatic one about the same words.
    const proposals = [...own, ...auto.filter((a) => !own.some((o) => o.from < a.to && a.from < o.to))];
    if (!proposals.length) return translate("There is nothing to propose: without long breaks, repetitions or mutillas, and you have not indicated phrases.");
    const saved = saveEditDocument(p.id, saveProposals(doc, asset.id, proposals, input.replace));
    const lines = proposals.map((x) => { const cut = proposalCut(words, x, CUT_MARGIN, energy); return proposalLine(x, cut ? cutSeconds(saved, asset.id, [cut]) : 0); });
    const total = cutSeconds(saved, asset.id, proposals.flatMap((x) => proposalCut(words, x, CUT_MARGIN, energy) ?? []));
    return translate("{0} proposed cuts in \"{1},\" without applying (they would save {2} s of {3} s). The user reviews them in {4}; tell him what you propose and why, and that he can apply them there or ask you to.\n{5}", proposals.length, asset.name, fmt(total), fmt(editDuration(saved)), CLEANUP_TAB, lines.join("\n"));
  },
});

const applyTranscriptCuts = tool({
  name: "apply_transcript_cuts",
  description: `Aplica cortes desde la transcripción: quita esas palabras o pausas de TODAS las pistas y cierra el hueco. Los subtítulos solo cambian de texto si pierden palabras: se conservan sus IDs y retoques, y el resto solo se desplaza para mantener la sincronía. Deja margin s de respiración junto a las palabras que se quedan. Aplica proposalIds (propuestas que el usuario ha aprobado), all=true (todas las propuestas pendientes de ese archivo) o cuts por números de palabra cuando el usuario pide quitar algo concreto («quita cuando digo…»). Lo quitado se puede recuperar con restore_transcript_words o en ${where}; Deshacer o una versión recuperan también el montaje anterior completo.`,
  schema: z.object({
    assetId: z.string().optional(),
    proposalIds: z.array(z.string()).max(400).default([]),
    all: z.boolean().default(false),
    cuts: z.array(z.object({ fromWord: z.number().int().min(0), toWord: z.number().int().min(0) })).max(80).default([]),
    margin: z.number().min(0).max(0.4).default(CUT_MARGIN),
  }),
  label: (i) => i.cuts.length && !i.proposalIds.length && !i.all ? translate("Remove Assembly phrases") : translate("Apply the proposed cuts"),
  run: async (input, ctx) => {
    const p = project(ctx);
    const asset = pickFile(p, input.assetId);
    const words = await wordsOf(p, asset);
    const energy = await energyOf(p, asset);
    const doc = project(ctx).edit;
    const pending = proposalsFor(doc, asset.id);
    const unknown = input.proposalIds.filter((id) => !pending.some((x) => x.id === id));
    if (unknown.length) throw new Error(translate("There are no proposals with these ids in \"{0}\": {1}. Earrings: {2}.", asset.name, unknown.join(", "), pending.map((x) => x.id).join(", ") || "ninguna"));
    const chosen = input.all ? pending : pending.filter((x) => input.proposalIds.includes(x.id));
    const spans = input.cuts.map((c) => wordSpan(words, c.fromWord, c.toWord));
    if (!chosen.length && !spans.length) throw new Error(translate("It indicates what to cut: proposalIds, all = true or cut by word numbers."));
    const before = editDuration(doc);
    let next = doc, removed = 0;
    if (chosen.length) {
      const result = applyCuts(next, asset.id, words, chosen.flatMap((x) => proposalCut(words, x, input.margin, energy) ?? []), chosen.map((x) => x.id));
      next = result.doc; removed += result.removed;
    }
    for (const [a, b] of spans) {
      const result = removeWords(next, asset.id, words, a, b, input.margin, energy);
      next = result.doc; removed += result.removed;
    }
    if (removed <= 0 && next === doc) return translate("Those words were no longer in the assembly: nothing has been cut.");
    const saved = saveEditDocument(p.id, next);
    const gone = spans.map(([a, b]) => `«${placeWords(doc, asset.id, words).slice(a, b + 1).map((w) => w.text).filter(Boolean).join(" ")}»`);
    return translate("Cut-off assembly {0}: from {1} to {2}, with {3} breathing next to each cut. {4} {5} The removed is removed in {6} and can be recovered.", secs(removed), secs(before), secs(editDuration(saved)), secs(input.margin), chosen.length ? ` ${chosen.length === 1 ? translate("Proposal implemented") : translate("{0} proposals implemented", chosen.length)}.` : "", gone.length ? ` Quitado: ${gone.join(", ")}.` : "", where);
  },
});

const restoreTranscriptWords = tool({
  name: "restore_transcript_words",
  description: "It recovers words removed from the assembly (which read_transcript marks [removed:...]): they return to their place next to the piece from which they came out and the rest moves to leave them empty on all tracks. Use the word numbers # n.",
  schema: z.object({ assetId: z.string().optional(), fromWord: z.number().int().min(0), toWord: z.number().int().min(0) }),
  label: () => translate("Recover Words in Mounting"),
  run: async (input, ctx) => {
    const p = project(ctx);
    const asset = pickFile(p, input.assetId);
    const words = await wordsOf(p, asset);
    const doc = project(ctx).edit;
    const [a, b] = wordSpan(words, input.fromWord, input.toWord);
    const missing = placeWords(doc, asset.id, words).slice(a, b + 1).filter((w) => !w.clipId);
    if (!missing.length) return translate("Those words are already in the assembly.");
    if (!doc.clips.some((c) => c.assetId === asset.id)) throw new Error(translate("\"{0}\" is not in the assembly: add it first to a track.", asset.name));
    const result = restoreWords(doc, asset.id, words, a, b, CUT_MARGIN, await energyOf(p, asset));
    const saved = saveEditDocument(p.id, result.doc);
    return translate("Recovered \"{0} '(+ {1}): the hard assembly {2}.", missing.map((w) => w.text).filter(Boolean).join(" "), secs(-result.removed), secs(editDuration(saved)));
  },
});

const setTranscriptCorrections = tool({
  name: "set_transcript_corrections",
  description: `Corrige nombres, marcas y términos mal reconocidos en la transcripción con un diccionario del proyecto («cloud code» → «Claude Code»): se aplica a todos los subtítulos actuales y a los que se creen después, sin tocar el audio. Hazlo ANTES de subtitular. from es lo que está escrito ahora (una o varias palabras; da igual mayúsculas y puntuación, no los acentos); to vacío oculta esas palabras de los subtítulos. remove quita correcciones por su from. El usuario las ve y edita en ${NAMES_TAB}.`,
  schema: z.object({
    add: z.array(transcriptCorrectionSchema).max(60).default([]),
    remove: z.array(z.string().max(120)).max(60).default([]),
  }),
  label: () => translate("Correct names in subtitles"),
  run: async (input, ctx) => {
    if (!input.add.length && !input.remove.length) throw new Error("Indica correcciones en add o remove.");
    const doc = project(ctx).edit;
    const changed = captionsCorrected(doc, input.add);
    const saved = saveEditDocument(ctx.projectId, setCorrections(doc, input.add, input.remove));
    const list = transcriptState(saved).corrections;
    return translate("Project dictionary: {0}. Subtitles corrected now: {1}.{2}", list.length ? list.map((c) => `«${c.from}» → «${c.to || "(oculto)"}»`).join(", ") : translate("empty"), changed, input.remove.length ? translate(" Remove a correction does not return the previous text to the already created subtitles: if necessary, recreate them with analyze_media.") : "");
  },
});

const highlightCaptionKeywords = tool({
  name: "highlight_caption_keywords",
  description: `Pinta en color la palabra clave de cada subtítulo (cifras, nombres, la idea principal), como en los reels. on=false lo quita. Sin words, el estudio elige una palabra por subtítulo; con words (las palabras que tú eliges tras leer los subtítulos o read_transcript), se marcan exactamente esas cada vez que aparecen. Vale para todos los subtítulos del proyecto y para los que se creen después. color en hex (por defecto ${DEFAULT_ACCENT}, amarillo); si hay referencia de estilo o marca, usa su color de acento. El usuario lo activa o cambia en Subtítulos › Subtítulos.`,
  schema: z.object({
    on: z.boolean().default(true),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    words: z.array(z.string().trim().min(1).max(80)).max(80).optional(),
  }),
  label: (i) => i.on ? translate("Highlight keywords") : translate("Remove the highlight from the subtitles"),
  run: async (input, ctx) => {
    const doc = project(ctx).edit;
    const current = transcriptState(doc).highlight;
    const saved = saveEditDocument(ctx.projectId, setHighlight(doc, input.on ? { color: input.color ?? current?.color ?? DEFAULT_ACCENT, ...(input.words?.length ? { words: input.words } : {}) } : null));
    const captions = saved.overlays.filter((o) => o.kind === "caption");
    if (!input.on) return translate("Highlights removed from subtitles.");
    const marked = captions.filter((o) => o.emphasis?.length);
    if (!captions.length) return translate("Activated highlight: will apply to the subtitles you believe.");
    return translate("{0} color keywords of {1} subtitles: {2} {3}.", marked.length, captions.length, marked.slice(0, 12).map((o) => `«${o.emphasis!.join(" ")}»`).join(", "), marked.length > 12 ? "…" : "");
  },
});

export const TRANSCRIPT_TOOLS = [readTranscript, proposeTranscriptCuts, applyTranscriptCuts, restoreTranscriptWords, setTranscriptCorrections, highlightCaptionKeywords];

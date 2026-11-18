"use client";

import { t as translate, localizedLabels } from "@/lib/i18n";
import { Fragment, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type PointerEvent } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { DEFAULT_ACCENT } from "@/lib/editing/emphasis";
import type { WordTiming } from "@/lib/domain";
import type { EditDocument } from "@/lib/editing/schema";
import type { TranscriptCorrection, TranscriptCutKind, TranscriptProposal } from "@/lib/editing/transcript-schema";
import {
  applyCuts, captionsCorrected, CUT_MARGIN, cutSeconds, DEFAULT_PAUSE, dismissProposals, placeWords, proposalCut, proposalsFor,
  removeWords, restoreWords, setCorrections, setHighlight, suggestCleanup, timelineAt, transcriptState, wordCut, type AudioEnergy, type SourceRange,
} from "@/lib/editing/transcript";
import { EditorIcon } from "./desktop-controls";
import "./transcript-panel.css";

/**
 * Editing the montage from what is said in one source file: the words as text (select and remove them, or
 * bring them back), a proposed cleanup to review, and the project's dictionary of names for the subtitles.
 */

export type TranscriptView = "words" | "cleanup" | "names";

interface TranscriptPanelProps {
  projectId: string;
  doc: EditDocument;
  /** The source file whose speech is edited. */
  assetId: string;
  view: TranscriptView;
  disabled: boolean;
  /** Playhead, to mark the word being heard. */
  time: number;
  onEdit: (update: (doc: EditDocument) => EditDocument) => void;
  onSeek: (time: number) => void;
  /** Writes a request in the assistant's box. */
  onAsk: (prompt: string) => void;
}

interface Transcript { words: WordTiming[]; energy?: AudioEnergy }

/** Word timings (and audio level) already fetched in this window, per project file. */
const fetched = new Map<string, Transcript>();

async function requestTranscript(projectId: string, assetId: string, body: { transcribe?: boolean; pauses?: boolean; energy?: boolean }) {
  const response = await fetch(`/api/projects/${projectId}/transcript`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ assetId, ...body }) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? translate("You couldn't read the transcript."));
  return data as { words: WordTiming[] | null; pauses?: SourceRange[]; energy?: AudioEnergy | null };
}

const toTranscript = (data: { words: WordTiming[] | null; energy?: AudioEnergy | null }): Transcript | null =>
  data.words?.length ? { words: data.words, ...(data.energy ? { energy: data.energy } : {}) } : null;

const secs = (n: number) => `${(Math.round(n * 10) / 10).toFixed(1).replace(".", ",")} s`;
const shorten = (text: string, max = 90) => text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;

export function TranscriptPanel(p: TranscriptPanelProps) {
  const key = `${p.projectId}:${p.assetId}`;
  const [loaded, setLoaded] = useState<Record<string, Transcript | null>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const transcript = fetched.get(key) ?? loaded[key];

  // Asked again on every mount: subtitles created from another tab may have transcribed the file meanwhile.
  useEffect(() => {
    if (fetched.has(key)) return;
    let live = true;
    requestTranscript(p.projectId, p.assetId, { energy: true })
      .then((data) => {
        if (!live) return;
        const found = toTranscript(data);
        if (found) fetched.set(key, found);
        setLoaded((l) => ({ ...l, [key]: found }));
      })
      .catch((e: Error) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [key, p.projectId, p.assetId]);

  async function transcribe() {
    setBusy(true); setError(null);
    try {
      const found = toTranscript(await requestTranscript(p.projectId, p.assetId, { transcribe: true, energy: true }));
      if (found) fetched.set(key, found);
      else setError(translate("No voice has been recognized in this audio."));
      setLoaded((l) => ({ ...l, [key]: found }));
    } catch (e) {
      setError(e instanceof Error ? e.message : translate("The audio could not be transcribed."));
    } finally { setBusy(false); }
  }

  if (transcript === undefined) return <p className="pro-panel-note" role="status">{error ?? translate("Charging the transcript…")}</p>;
  if (transcript === null) {
    return <div className="tx-empty">
      <p>{translate("First you have to read what is said in this audio. Then you will see every word: you can remove phrases as if you delete text and the video will be cut alone.")}</p>
      <Button variant="primary" className="w-full justify-center" disabled={p.disabled || busy} onClick={() => void transcribe()}><EditorIcon name="sparkles" />{busy ? "Leyendo lo que se dice…" : "Leer lo que se dice"}</Button>
      {busy && <p className="pro-panel-note" role="status">{translate("The first time you download the voice model and it may take a few minutes. You don't have to wait here.")}</p>}
      {error && <p className="tx-error" role="alert">{error}</p>}
    </div>;
  }
  if (p.view === "cleanup") return <CleanupView {...p} {...transcript} />;
  if (p.view === "names") return <NamesView {...p} {...transcript} />;
  return <WordsView {...p} {...transcript} />;
}

type ViewProps = TranscriptPanelProps & Transcript;

// ---------------------------------------------------------------- words

function WordsView({ doc, assetId, words, energy, disabled, time, onEdit, onSeek }: ViewProps) {
  const placed = useMemo(() => placeWords(doc, assetId, words), [doc, assetId, words]);
  const [selection, setSelection] = useState<{ anchor: number; focus: number } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const dragging = useRef(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const stop = () => { dragging.current = false; };
    window.addEventListener("pointerup", stop);
    return () => window.removeEventListener("pointerup", stop);
  }, []);

  // A word a correction merged into the one before it («cloud code» → «Claude Code») goes with it.
  let range: [number, number] | null = null;
  if (selection && placed.length) {
    let a = Math.max(0, Math.min(selection.anchor, selection.focus)), b = Math.min(placed.length - 1, Math.max(selection.anchor, selection.focus));
    while (a > 0 && !placed[a].text) a--;
    while (b + 1 < placed.length && !placed[b + 1].text) b++;
    range = [a, b];
  }
  const chosen = range ? placed.slice(range[0], range[1] + 1) : [];
  const inside = chosen.filter((w) => w.clipId).length, outside = chosen.length - inside;
  const saving = range && inside ? cutSeconds(doc, assetId, [wordCut(words, range[0], range[1], CUT_MARGIN, energy)]) : 0;
  const heard = placed.filter((w) => w.clipId).length;
  const now = placed.find((w) => w.at !== null && time >= w.at && time < Math.max(w.until!, w.at + 0.08));

  const runAround = (i: number) => {
    let a = i, b = i;
    while (a > 0 && !placed[a - 1].clipId) a--;
    while (b < placed.length - 1 && !placed[b + 1].clipId) b++;
    return { anchor: a, focus: b };
  };
  function press(e: PointerEvent, i: number) {
    if (disabled || e.button !== 0) return;
    e.preventDefault();
    box.current?.focus();
    dragging.current = true;
    setNote(null);
    // Clicking a removed word picks the whole removed stretch: it is what «Recuperar» brings back.
    setSelection(e.shiftKey && selection ? { ...selection, focus: i } : placed[i].clipId ? { anchor: i, focus: i } : runAround(i));
    if (placed[i].at !== null) onSeek(placed[i].at!);
  }
  function remove() {
    if (!range || !inside) return;
    const [a, b] = range;
    onEdit((d) => removeWords(d, assetId, words, a, b, CUT_MARGIN, energy).doc);
    setNote(translate("Remove from the video (− {0}). It is deleted: select it and press \"Recover\" if you want it back.", secs(saving)));
    setSelection(null);
  }
  function restore() {
    if (!range || !outside) return;
    const [a, b] = range;
    onEdit((d) => restoreWords(d, assetId, words, a, b, CUT_MARGIN, energy).doc);
    setNote(translate("Recovered: you have returned to your site in the video."));
    setSelection(null);
  }
  function step(from: number, by: number) {
    let k = from + by;
    while (k > 0 && k < placed.length - 1 && !placed[k].text) k += by;
    return Math.max(0, Math.min(placed.length - 1, k));
  }
  function keys(e: KeyboardEvent) {
    if (disabled) { if (e.key === "Delete" || e.key === "Backspace") e.preventDefault(); return; }
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      const next = step(selection?.focus ?? now?.index ?? -1, e.key === "ArrowLeft" ? -1 : 1);
      setSelection(e.shiftKey && selection ? { ...selection, focus: next } : { anchor: next, focus: next });
      const target = placed[next];
      if (target && target.at !== null) onSeek(target.at);
      box.current?.querySelector(`[data-word="${next}"]`)?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Delete" || e.key === "Backspace") {
      // Never the studio's own Delete: it would remove the clip selected on the timeline.
      e.preventDefault();
      remove();
    }
    else if (e.key === "Enter" && outside) { e.preventDefault(); restore(); }
    else if (e.key === "Escape" && selection) { e.preventDefault(); setSelection(null); }
  }

  return <div className="tx-view">
    <p className="pro-panel-note">{translate("Select words (click and drag, or Mayus + click) and click")} <strong>{translate("Remove from video")}</strong>{translate(": the assembly is cut alone and the other tracks are still synchronized. The removed is removed and can be recovered.")}</p>
    <p className="tx-stats">{heard}{translate("of")} {placed.length}{translate("words in the video")}</p>
    <div ref={box} className="tx-words" role="listbox" aria-multiselectable="true" aria-label={translate("Audio transcript")} aria-activedescendant={selection ? `tx-w-${selection.focus}` : undefined} tabIndex={0} onKeyDown={keys}>
      {placed.map((w, k) => {
        if (!w.text) return null;
        const prev = placed[k - 1];
        const pause = prev?.at != null && w.at !== null && prev.until !== null ? w.at - prev.until : 0;
        const picked = !!range && k >= range[0] && k <= range[1];
        return <Fragment key={k}>
          {pause >= DEFAULT_PAUSE && <span className="tx-pause" title={translate("Pause in the video")}>{secs(pause)}</span>}
          <span id={`tx-w-${k}`} data-word={k} role="option" aria-selected={picked} className={`tx-word${w.clipId ? "" : " is-out"}${picked ? " is-picked" : ""}${now?.index === k ? " is-now" : ""}`}
            onPointerDown={(e) => press(e, k)} onPointerEnter={() => { if (dragging.current) setSelection((s) => s && { ...s, focus: k }); }}>{w.text}</span>{" "}
        </Fragment>;
      })}
    </div>
    {range && <div className="tx-actions" role="toolbar" aria-label={translate("Selected words")}>
      <p>«{shorten(chosen.map((w) => w.text).filter(Boolean).join(" "))}»{inside ? <span> · {secs(saving)}</span> : null}</p>
      <div>
        {inside > 0 && <Button size="sm" variant="primary" disabled={disabled} onClick={remove}><EditorIcon name="trash" />{translate("Remove from video")}</Button>}
        {outside > 0 && <Button size="sm" variant="outline" disabled={disabled} onClick={restore}><EditorIcon name="undo" />{translate("Recover")}</Button>}
        <Button size="icon-sm" aria-label={translate("Cancel the selection")} onClick={() => setSelection(null)}><EditorIcon name="close" /></Button>
      </div>
    </div>}
    {note && <p className="tx-note" role="status">{note}</p>}
  </div>;
}

// ---------------------------------------------------------------- cleanup

const KIND_LABELS: Record<TranscriptCutKind, string> = localizedLabels((translate) => ({ pause: translate("Long pauses"), retake: translate("Repeated takes"), filler: "Muletillas y dudas", phrase: "Frases que sobran" }));
const KIND_ORDER: TranscriptCutKind[] = ["phrase", "retake", "pause", "filler"];
const PAUSES = [0.3, 0.4, 0.7, 1];
const BREATHS: [number, string][] = [[0.05, "Seca"], [0.1, "Natural"], [0.2, "Pausada"]];
const ASK_CLEANUP = "Prop what sentences to remove to make the video go to the point and last about 30 seconds.";

function CleanupView({ projectId, doc, assetId, words, energy, disabled, onEdit, onSeek, onAsk }: ViewProps) {
  const [minPause, setMinPause] = useState(DEFAULT_PAUSE);
  const [margin, setMargin] = useState(CUT_MARGIN);
  /** Quiet stretches of the audio; null until the user asks for the cleanup. */
  const [silences, setSilences] = useState<SourceRange[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fromAssistant = proposalsFor(doc, assetId);
  // Recomputed against the montage as it is: what was applied or removed by hand drops out on its own.
  const found = useMemo(() => silences ? suggestCleanup(doc, assetId, words, { minPause, silences, energy }) : [], [silences, doc, assetId, words, minPause, energy]);
  const items = [...fromAssistant, ...found.filter((a) => !fromAssistant.some((o) => o.from < a.to && a.from < o.to))]
    .map((proposal) => { const cut = proposalCut(words, proposal, margin, energy); return { proposal, cut, seconds: cut ? cutSeconds(doc, assetId, [cut]) : 0 }; })
    .filter((x) => x.seconds > 0.04);
  const isChecked = (x: TranscriptProposal) => checked[x.id] ?? x.preselect ?? true;
  const chosen = items.filter((x) => isChecked(x.proposal));
  const total = cutSeconds(doc, assetId, chosen.flatMap((x) => x.cut ?? []));

  async function search() {
    setSearching(true); setError(null); setNote(null);
    try {
      const data = await requestTranscript(projectId, assetId, { pauses: true });
      setSilences(data.pauses ?? []);
      setChecked({});
    } catch (e) { setError(e instanceof Error ? e.message : translate("You couldn't analyze the audio.")); }
    finally { setSearching(false); }
  }
  function apply() {
    if (!chosen.length) return;
    const ranges = chosen.flatMap((x) => x.cut ?? []);
    const settled = chosen.map((x) => x.proposal.id);
    onEdit((d) => applyCuts(d, assetId, words, ranges, settled).doc);
    setNote(translate("Applied cleaning: − {0}. What is removed appears in Words in case you want to recover something.", secs(total)));
  }
  function seekTo(x: TranscriptProposal) {
    const at = timelineAt(doc, assetId, Math.max(0, x.from - 0.3)) ?? timelineAt(doc, assetId, x.from);
    if (at !== null) onSeek(at);
  }

  return <div className="tx-view">
    <p className="pro-panel-note">{translate("Look for what is usually left over when speaking: long breaks, phrases said twice (you stay the last) and mutillas. Nothing is cut until you click Apply.")}</p>
    <span className="pro-section-label">{translate("Pause from")}</span>
    <div className="pro-chip-options" role="group" aria-label={translate("Pause from")}>{PAUSES.map((v) => <button type="button" key={v} aria-pressed={minPause === v} onClick={() => setMinPause(v)}>{secs(v)}</button>)}</div>
    <span className="pro-section-label">{translate("Breathing next to each cut")}</span>
    <div className="pro-chip-options" role="group" aria-label={translate("Breathing next to each cut")}>{BREATHS.map(([v, label]) => <button type="button" key={v} aria-pressed={margin === v} title={translate("{0} before and after each cut", secs(v))} onClick={() => setMargin(v)}>{label}</button>)}</div>
    {silences === null || searching
      ? <Button variant="primary" className="w-full justify-center" disabled={disabled || searching} onClick={() => void search()}><EditorIcon name="search" />{searching ? "Escuchando el audio…" : translate("Find out what's left of it")}</Button>
      : !items.length && !note && <p className="tx-note" role="status">{translate("There's nothing left to clean up with these settings. Try shorter breaks or ask the assistant for phrases.")}</p>}
    {error && <p className="tx-error" role="alert">{error}</p>}
    {KIND_ORDER.map((kind) => {
      const group = items.filter((x) => x.proposal.kind === kind);
      if (!group.length) return null;
      return <section key={kind} className="tx-group" aria-label={KIND_LABELS[kind]}>
        <div className="pro-subsection-title">{KIND_LABELS[kind]} <span>{group.length}</span></div>
        <ul className="tx-proposals">{group.map(({ proposal: x, seconds }) => <li key={x.id}>
          <label>
            <input type="checkbox" checked={isChecked(x)} disabled={disabled} onChange={(e) => setChecked((c) => ({ ...c, [x.id]: e.target.checked }))} />
            <span className="tx-proposal-text">
              {x.text ? <strong>«{shorten(x.text, 120)}»</strong> : <strong>{x.reason}</strong>}
              {x.text && <small>{x.reason}</small>}
              {!x.id.startsWith("auto-") && <small className="tx-badge">{translate("Suggested by the assistant")}</small>}
            </span>
            <span className="tx-proposal-time">−{secs(seconds)}</span>
          </label>
          <button type="button" className="tx-seek" aria-label={translate("Go to this moment of the video")} title={translate("Jump to this moment")} onClick={() => seekTo(x)}><EditorIcon name="play" /></button>
        </li>)}</ul>
      </section>;
    })}
    {items.length > 0 && <div className="tx-apply">
      <Button variant="primary" className="w-full justify-center" disabled={disabled || !chosen.length} onClick={apply}><EditorIcon name="check" />{chosen.length ? `Aplicar ${chosen.length} ${chosen.length === 1 ? "corte" : "cortes"} (−${secs(total)})` : translate("Mark what to remove")}</Button>
      {fromAssistant.length > 0 && <Button variant="link" size="inline" disabled={disabled} onClick={() => onEdit((d) => dismissProposals(d, fromAssistant.map((x) => x.id)))}>{translate("Discard the assistant's proposals")}</Button>}
    </div>}
    {note && <p className="tx-note" role="status">{note}</p>}
    <div className="tx-ask">
      <p>{translate("The remaining phrases need criteria: ask the assistant and they will appear here to review them. For example:")}</p>
      <button type="button" disabled={disabled} onClick={() => onAsk(ASK_CLEANUP)}>«{ASK_CLEANUP}»</button>
    </div>
  </div>;
}

// ---------------------------------------------------------------- names

const ASK_NAMES = "Check the transcript and correct the names, marks and miswritten terms before putting in subtitles.";

/** Words worth a look: capitalised in mid-sentence (names, brands) or with digits. */
function nameCandidates(words: WordTiming[], corrections: TranscriptCorrection[]): string[] {
  const known = new Set(corrections.map((c) => c.from.toLocaleLowerCase("es")));
  const seen = new Set<string>(), out: string[] = [];
  words.forEach((w, k) => {
    const core = w.text.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
    const midSentence = k > 0 && !/[.!?…]["»”)]?$/.test(words[k - 1].text);
    if (!core || !((midSentence && /^\p{Lu}/u.test(core)) || /\d/.test(core))) return;
    const lower = core.toLocaleLowerCase("es");
    if (seen.has(lower) || known.has(lower)) return;
    seen.add(lower); out.push(core);
  });
  return out.slice(0, 14);
}

function NamesView({ doc, words, disabled, onEdit, onAsk }: ViewProps) {
  const corrections = transcriptState(doc).corrections;
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const candidates = useMemo(() => nameCandidates(words, corrections), [words, corrections]);

  function add(e: FormEvent) {
    e.preventDefault();
    const correction = { from: from.trim(), to: to.trim() };
    if (!correction.from || disabled) return;
    const changed = captionsCorrected(doc, [correction]);
    onEdit((d) => setCorrections(d, [correction]));
    setNote(changed ? translate("Corrected in {0} {1}. It will also work out well in those you believe later.", changed, changed === 1 ? translate("subtitle") : translate("subtitles")) : translate("Saving: It will work out well in the subtitles you believe from now on."));
    setFrom(""); setTo("");
  }

  return <div className="tx-view">
    <p className="pro-panel-note">{translate("Automatic transcription is often wrong with names, marks and technical terms. It writes how they should appear: it is corrected in the subtitles now and in those you believe later. The audio does not change.")}</p>
    <form className="tx-name-form" onSubmit={add}>
      <label className="pro-label">{translate("It's written")}<input value={from} maxLength={120} placeholder="cloud code" disabled={disabled} onChange={(e) => setFrom(e.target.value)} /></label>
      <label className="pro-label">{translate("Change to")}<input value={to} maxLength={120} placeholder="Claude Code" disabled={disabled} onChange={(e) => setTo(e.target.value)} /></label>
      <Button type="submit" variant="outline" size="sm" disabled={disabled || !from.trim()}><EditorIcon name="plus" />{translate("Add correction")}</Button>
      <small className="pro-panel-note">{translate("Let \"It must put\" empty so that those words don't come out in the subtitles.")}</small>
    </form>
    {note && <p className="tx-note" role="status">{note}</p>}
    {corrections.length > 0 && <>
      <div className="pro-subsection-title">{translate("Project corrections")} <span>{corrections.length}</span></div>
      <ul className="tx-names">{corrections.map((c) => <li key={c.from}>
        <span>{c.from}</span><span aria-hidden>→</span><strong>{c.to || "(no sale)"}</strong>
        <Button size="icon-sm" aria-label={translate("Remove the correction of \"{0}\"", c.from)} disabled={disabled} onClick={() => onEdit((d) => setCorrections(d, [], [c.from]))}><EditorIcon name="close" /></Button>
      </li>)}</ul>
      <p className="pro-panel-note">{translate("Remove a correction does not change the subtitles that have already been corrected: use Undo or recreate them.")}</p>
    </>}
    {candidates.length > 0 && <>
      <div className="pro-subsection-title">{translate("To review")} <span>{candidates.length}</span></div>
      <p className="pro-panel-note">{translate("Names and numbers of the transcript. Press one if it is miswritten.")}</p>
      <div className="pro-chip-options" role="group" aria-label={translate("Words to review")}>{candidates.map((c) => <button type="button" key={c} disabled={disabled} onClick={() => { setFrom(c); setTo(c); }}>{c}</button>)}</div>
    </>}
    <div className="tx-ask">
      <p>{translate("You can also ask the assistant for it, for example:")}</p>
      <button type="button" disabled={disabled} onClick={() => onAsk(ASK_NAMES)}>«{ASK_NAMES}»</button>
    </div>
  </div>;
}

// ---------------------------------------------------------------- keywords

const ACCENTS: [string, string][] = [[DEFAULT_ACCENT, "Amarillo"], ["#34c759", "Verde"], ["#ff9f0a", "Naranja"], ["#5ac8fa", "Azul"], ["#ff375f", "Rosa"]];
const ASK_KEYWORDS = "He highlights in the subtitles the key words of each sentence, at most one per subtitle.";

/** Keywords of the subtitles in a colour: on or off for the whole project, with its colour. */
export function CaptionHighlight({ doc, disabled, onEdit, onAsk }: { doc: EditDocument; disabled: boolean; onEdit: (update: (doc: EditDocument) => EditDocument) => void; onAsk: (prompt: string) => void }) {
  const highlight = transcriptState(doc).highlight;
  const marked = doc.overlays.filter((o) => o.kind === "caption" && o.emphasis?.length).length;
  return <section className="tx-highlight" aria-label={translate("Keywords")}>
    <label className="tx-highlight-row">
      <span><strong>{translate("Highlight keywords")}</strong><small>{highlight ? translate("{0} subtitles with a word in color {1}.", marked, highlight.words ? ", elegidas por el asistente" : "") : translate("A word for each subtitle in color: figures, names or the main idea.")}</small></span>
      <Switch checked={!!highlight} disabled={disabled} aria-label={translate("Highlight keywords")} onCheckedChange={(on) => onEdit((d) => setHighlight(d, on ? { color: highlight?.color ?? DEFAULT_ACCENT } : null))} />
    </label>
    {highlight && <div className="tx-swatches" role="group" aria-label={translate("Color of the keywords")}>{ACCENTS.map(([color, label]) => <button type="button" key={color} aria-label={label} title={label} aria-pressed={highlight.color.toLowerCase() === color} disabled={disabled} style={{ background: color }} onClick={() => onEdit((d) => setHighlight(d, { ...highlight, color }))} />)}</div>}
    {highlight && <div className="tx-ask">
      <p>{translate("To better choose which word to highlight, ask the assistant:")}</p>
      <button type="button" disabled={disabled} onClick={() => onAsk(ASK_KEYWORDS)}>«{ASK_KEYWORDS}»</button>
    </div>}
  </section>;
}

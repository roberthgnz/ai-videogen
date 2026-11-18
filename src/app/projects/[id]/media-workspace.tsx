"use client";

import { t as translate } from "@/lib/i18n";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useEffectEvent, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/alert-dialog";
import { Select, SelectItem } from "@/components/ui/select";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/dropdown-menu";
import { ColorField, EditorIcon, KeyboardHelp, NumberField, ToolButton, VolumeField } from "./desktop-controls";
import { LIBRARY_PANELS, WorkspaceLibrary, ExportDialog, type ExportTarget, type LibraryPanel } from "./studio-panels";
import { StudioTimeline } from "./studio-timeline";
import { assetLane, fitChangedTimeline, mergeSavedEdit, moveItem, removeItems, withTracks, type TimelineKind } from "@/lib/editing/timeline";
import type { VideoFormat } from "@/lib/domain";
import "./studio.css";
import { musicClipDefaults, syncMusic } from "@/lib/editing/music";
import { fileReference, needsTranscript, transcriptText } from "@/lib/editing/references";
import { captionsForClips, editDuration, keptRanges, newOverlay, parseSubtitles, splitClip, rippleSilences, SILENCE_PAD,
  type EditAsset, type EditClip, type EditDocument, type EditOverlay } from "@/lib/editing/schema";
import { montageCaptions } from "@/lib/editing/transcript";
import { startVideoAction, cancelVideoAction } from "./actions";
import { applyClipEffects, type EffectsRequest } from "@/lib/editing/effects";
import { CLIP_MOTIONS, CLIP_TRANSITIONS, MOTION_LABELS, SPEED_CHOICES, speedLabel, TRANSITION_LABELS } from "@/lib/editing/motion";
import { sendAgentMessageAction, undoAgentTurnAction } from "./agent-actions";
import { saveEditAction, loadRenderedVideoAction, removeAssetAction, addGlobalAssetToProjectAction } from "./edit-actions";
import { EditCanvas } from "./edit-canvas";
import type { EditorProject } from "./types";
import type { AgentView } from "./studio";
import type { ExportQuality } from "@/lib/app-settings-shared";
import { ScriptTools } from "./script-tools";
import { AgentChat } from "./agent-chat";
import { SideResizer } from "./side-resizer";
import type { UploadingFile } from "./asset-card";
import { ExportHistory } from "./export-history";
import { STAGES } from "./video-panel";
import { PassChip, PassesNow, passesShown, PassesStrip } from "./passes-panel";
import { saveVideo } from "@/lib/desktop";

const round = (n: number) => Math.round(n * 1000) / 1000;
const uploadKind = (file: File): UploadingFile["kind"] => file.type.startsWith("video/") ? "video" : file.type.startsWith("image/") ? "image" : file.type.startsWith("audio/") ? "audio" : "document";
/** A multipart POST that reports how much has gone up (fetch cannot). Resolves with the JSON reply. */
function postWithProgress(url: string, body: FormData, onProgress: (percent: number) => void): Promise<{ ok: boolean; data: { error?: string; edit?: EditDocument } }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress((e.loaded / e.total) * 100); };
    xhr.upload.onload = () => onProgress(100);
    xhr.onload = () => { try { resolve({ ok: xhr.status >= 200 && xhr.status < 300, data: JSON.parse(xhr.responseText) }); } catch { reject(new Error(translate("Unvalid server response."))); } };
    xhr.onerror = () => reject(new Error(translate("The connection was lost when the file was uploaded.")));
    xhr.send(body);
  });
}
/** Minutes, seconds and hundredths: what the transport shows. */
function clock(seconds: number) { const cs = Math.max(0, Math.round(seconds * 100)); return `${Math.floor(cs / 6000)}:${String(Math.floor(cs / 100) % 60).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`; }
const libraryMediaQuery = "(min-width: 980px)";
function subscribeLibraryWidth(onChange: () => void) { const query = window.matchMedia(libraryMediaQuery); query.addEventListener('change', onChange); return () => query.removeEventListener('change', onChange); }
/** Below this width the side panel would cover the preview, so it starts closed. */
const sideMediaQuery = "(min-width: 740px)";
function subscribeSideWidth(onChange: () => void) { const query = window.matchMedia(sideMediaQuery); query.addEventListener('change', onChange); return () => query.removeEventListener('change', onChange); }

export function MediaWorkspace({ project, agent, exportQuality, exportFolder }: { project: EditorProject; agent: AgentView; exportQuality: ExportQuality; exportFolder: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [doc, setDoc] = useState(project.edit);
  const [baseline, setBaseline] = useState(JSON.stringify(project.edit));
  const [remoteRevision, setRemoteRevision] = useState(project.edit.revision);
  const [history, setHistory] = useState<EditDocument[]>([]);
  const [future, setFuture] = useState<EditDocument[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  /** The assistant reply whose undo waits for the user's confirmation (the montage changed after it). */
  const [undoAsk, setUndoAsk] = useState<string | null>(null);
  const [panel, setPanel] = useState<LibraryPanel>(searchParams.get("panel") === "exports" ? "exports" : "media");
  const wide = useSyncExternalStore(subscribeLibraryWidth, () => window.matchMedia(libraryMediaQuery).matches, () => true);
  const [libraryOpen, setLibraryOpen] = useState<boolean | null>(null);
  const showLibrary = libraryOpen ?? wide;
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const roomy = useSyncExternalStore(subscribeSideWidth, () => window.matchMedia(sideMediaQuery).matches, () => true);
  const [assistantChoice, setAssistantOpen] = useState<boolean | null>(null);
  const assistantOpen = assistantChoice ?? roomy;
  const [scriptDirty, setScriptDirty] = useState(false);
  const [uploads, setUploads] = useState<UploadingFile[]>([]);
  const [scriptTab, setScriptTab] = useState<"scenes" | "settings">("scenes");
  const [dismissedRun, setDismissedRun] = useState<string | null>(null);
  const generatedVideo = useRef<HTMLVideoElement>(null);
  const loadedGenerated = useRef<string | null>(null);
  const [focusMode, setFocusMode] = useState(false);
  const [canvasZoom, setCanvasZoom] = useState<string>("fit");
  const [exportOpen, setExportOpen] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  /** The export started from this window: when it finishes, the toast says where it was saved. */
  const [launchedRun, setLaunchedRun] = useState<string | null>(null);
  const [title, setTitle] = useState(project.title || project.topic || translate("Untitled"));
  const [format, setFormat] = useState<VideoFormat>(project.format);
  const [savedDetails, setSavedDetails] = useState({ title: project.title || project.topic || translate("Untitled"), format: project.format });
  const metadata = JSON.stringify([project.title, project.format]);
  const [incomingMetadata, setIncomingMetadata] = useState(metadata);
  if (metadata !== incomingMetadata) {
    if (title === savedDetails.title && format === savedDetails.format) {
      const nextTitle = project.title || project.topic || translate("Untitled");
      setTitle(nextTitle); setFormat(project.format); setSavedDetails({ title: nextTitle, format: project.format });
    }
    setIncomingMetadata(metadata);
  }
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [interacting, setInteracting] = useState(false);
  /** The montage as a timeline drag would leave it, shown on the canvas while the drag lasts. */
  const [preview, setPreview] = useState<EditDocument | null>(null);
  /** The main video track keeps its clips back to back. */
  const [magnetic, setMagnetic] = useState(true);
  const [dragFiles, setDragFiles] = useState(false);
  const ownRevision = useRef(project.edit.revision);
  const savePromise = useRef<ReturnType<typeof saveEditAction> | null>(null);
  const historyGroup = useRef<string | null>(null);
  const historyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const playbackTime = useRef(0);
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [referenceOnly, setReferenceOnly] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [guides, setGuides] = useState(false);
  const uploadRef = useRef<HTMLInputElement>(null);
  const subtitleRef = useRef<HTMLInputElement>(null);
  const dirty = JSON.stringify(doc) !== baseline || title.trim() !== savedDetails.title || format !== savedDetails.format;
  if (project.edit.revision > remoteRevision) {
    if (!dirty) { setDoc(project.edit); setBaseline(JSON.stringify(project.edit)); setTitle(project.title || project.topic || translate("Untitled")); setFormat(project.format); setSavedDetails({ title: project.title || project.topic || translate("Untitled"), format: project.format }); setHistory([]); setFuture([]); }
    setRemoteRevision(project.edit.revision);
  }
  const running = project.videos.find((v) => ["queued", "composing", "rendering"].includes(v.status));
  const locked = !!working || agent.busy;
  const latest = project.videos.find((v) => v.status === "done" && v.url) ?? Object.values(project.previews).find((v) => v.status === "done" && v.url);
  const viewGenerated = !doc.clips.length && !doc.overlays.length && !!latest?.url;
  const total = viewGenerated ? latest?.durationSec ?? latest?.expectedDurationSec ?? 15 : editDuration(doc);
  const overlay = doc.overlays.find((o) => o.id === selected);
  const clip = doc.clips.find((c) => c.id === selected);
  const asset = clip ? doc.assets.find((a) => a.id === clip.assetId) : undefined;

  const reportError = useCallback((message: string) => { setError(message); setPlaying(false); }, []);
  useEffect(() => { if (viewGenerated && !playing) generatedVideo.current?.pause(); }, [viewGenerated, playing]);
  const loadReadyVideo = useEffectEvent(async () => {
    const result = await loadRenderedVideoAction(project.id);
    if (result.ok) { accept(result.edit); setSelected(null); setTime(0); }
    else setError(result.error);
  });
  useEffect(() => {
    if (!viewGenerated || dirty || locked || running || !latest || !project.videos.some((video) => video.id === latest.id) || loadedGenerated.current === latest.id) return;
    loadedGenerated.current = latest.id;
    void loadReadyVideo().catch(() => reportError(translate("The video generated could not be added to the assembly.")));
  }, [viewGenerated, dirty, locked, running, latest, project.videos, reportError]);

  useEffect(() => {
    if (!running && !agent.busy) return;
    const timer = setInterval(() => router.refresh(), 1200);
    return () => clearInterval(timer);
  }, [running, agent.busy, router]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  // The ref is the clock while playing; the state is only what the screen shows, so it must not rewind it.
  useEffect(() => { if (!playing) playbackTime.current = time; }, [time, playing]);
  useEffect(() => {
    if (!playing) return;
    let frame = 0, last: number | null = null, shown = -Infinity;
    const tick = (now: number) => {
      const delta = last === null ? 0 : Math.min((now - last) / 1000, 0.2);
      last = now;
      playbackTime.current = viewGenerated && generatedVideo.current ? generatedVideo.current.currentTime : Math.min(total, playbackTime.current + delta);
      // The export is 30 fps: repainting the whole studio faster than that only burns the CPU the video decoders need.
      if (now - shown >= 33 || playbackTime.current >= total) { shown = now; setTime(playbackTime.current); }
      if (playbackTime.current >= total) { setPlaying(false); return; }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, total, viewGenerated]);

  function checkpoint(from = doc) { setHistory((h) => JSON.stringify(h.at(-1)) === JSON.stringify(from) ? h : [...h.slice(-39), from]); setFuture([]); historyGroup.current = null; }
  function change(update: (d: EditDocument) => EditDocument, remember = true, key?: string) {
    if (locked) return;
    if (remember && (!key || historyGroup.current !== key)) checkpoint();
    if (key) {
      historyGroup.current = key;
      if (historyTimer.current) clearTimeout(historyTimer.current);
      historyTimer.current = setTimeout(() => { historyGroup.current = null; }, 800);
    }
    setDoc((d) => ({ ...fitChangedTimeline(d, update(d)), enabled: true })); setError(null); setSaveError(null);
  }
  function patchOverlay(id: string, patch: Partial<EditOverlay>, remember = true) {
    change((d) => ({ ...d, overlays: d.overlays.map((o) => o.id === id ? { ...o, ...patch } : o) }), remember, `${id}:${Object.keys(patch).join()}`);
  }
  /** Transition and camera move for the selected clip or for every picture clip (the first, and pieces that continue a shot, stay cuts). */
  function applyEffects(scope: 'selected' | 'all', request: Omit<EffectsRequest, 'clipIds'>) {
    change((d) => applyClipEffects(d, { ...request, clipIds: scope === 'selected' && selected ? [selected] : undefined }).doc);
  }
  function patchClip(patch: Partial<EditClip>) {
    change((d) => ({ ...d, clips: d.clips.map((c) => c.id === selected ? { ...c, ...patch } : c) }));
  }
  function accept(saved: EditDocument, sent?: EditDocument) { ownRevision.current = saved.revision; setDoc((current) => sent ? mergeSavedEdit(current, sent, saved) : saved); setBaseline(JSON.stringify(saved)); setRemoteRevision(saved.revision); }
  async function save(current = doc, details = { title: title.trim(), format }): Promise<EditDocument | null> {
    while (savePromise.current) { try { await savePromise.current; } catch { /* The preceding save reports its own error. */ } }
    if (!details.title || current.overlays.some((o) => !o.text.trim())) { setSaveError(translate("Complete the title and empty texts before saving.")); return null; }
    const sent = { ...current, revision: Math.max(current.revision, ownRevision.current), enabled: true };
    setSaving(true);
    const task = saveEditAction(project.id, sent, details);
    savePromise.current = task;
    try {
      const result = await task;
      if (!result.ok) { setSaveError(result.error); return null; }
      accept(result.edit, sent); setSavedDetails(details); setSaveError(null); return result.edit;
    } catch (e) { setSaveError(e instanceof Error ? e.message : translate("It couldn't be kept, try again.")); return null; }
    finally { if (savePromise.current === task) savePromise.current = null; setSaving(false); }
  }
  const autoSave = useEffectEvent(() => { void save(); });
  useEffect(() => {
    if (!dirty || locked || saving || interacting || saveError || !title.trim() || doc.overlays.some((o) => !o.text.trim()) || remoteRevision > Math.max(doc.revision, ownRevision.current)) return;
    const timer = setTimeout(() => autoSave(), 900);
    return () => clearTimeout(timer);
  }, [doc, dirty, locked, saving, interacting, saveError, title, format, remoteRevision]);
  async function perform(label: string, run: () => Promise<void>) {
    setWorking(label); setPlaying(false); setError(null); setNotice(null);
    try { await run(); } catch (e) { setError(e instanceof Error ? e.message : translate("The operation could not be completed.")); }
    finally { setWorking(null); router.refresh(); }
  }
  function addAsset(target: EditAsset, current = doc, at?: number): EditDocument {
    if (target.kind === "document") return current;
    const end = Math.max(0, ...current.clips.filter((c) => current.assets.find((a) => a.id === c.assetId)?.kind === (target.kind === "audio" ? "audio" : "video") || (target.kind !== "audio" && current.assets.find((a) => a.id === c.assetId)?.kind === "image")).map((c) => c.start + c.duration));
    const defaults = target.kind === "audio" ? musicClipDefaults(current, target, Math.max(0, at ?? end)) : null;
    const duration = defaults?.duration ?? (target.kind === "image" ? 5 : target.duration);
    const start = Math.max(0, Math.min(7200 - duration, at ?? end));
    const newClip: EditClip = { id: crypto.randomUUID(), assetId: target.id, start: round(start), in: 0, duration, volume: defaults?.volume ?? 1, fit: "contain", transition: "cut", motion: "none" };
    return { ...current, enabled: true, duration: Math.max(current.clips.length || current.overlays.length ? current.duration : 0.1, start + duration), clips: [...current.clips, newClip] };
  }
  async function upload(files: File[], asReference = referenceOnly) {
    await perform(translate("Importing files…"), async () => {
      if (dirty && !(await save())) return;
      let importFormat = format;
      let latest: EditDocument | null = null;
      const guides: EditAsset[] = [];
      // Every file shows up in the library at once, with its own progress, until the server has it.
      const queued = files.map((file) => ({ key: crypto.randomUUID(), name: file.name, progress: 0, kind: uploadKind(file), preview: /^(image|video)\//.test(file.type) ? URL.createObjectURL(file) : null }));
      if (!asReference) { setUploads((u) => [...u, ...queued]); setPanel("media"); setLibraryOpen(true); }
      const done = (key: string) => setUploads((u) => { const gone = u.find((f) => f.key === key); if (gone?.preview) URL.revokeObjectURL(gone.preview); return u.filter((f) => f.key !== key); });
      try {
      for (const [index, file] of files.entries()) {
        const slot = queued[index];
        setWorking(`Importando ${file.name}…`);
        const form = new FormData(); form.set("file", file);
        const { ok, data } = await postWithProgress(`/api/projects/${project.id}/media`, form, (progress) => setUploads((u) => u.map((f) => f.key === slot.key ? { ...f, progress } : f)));
        done(slot.key);
        if (!ok) throw new Error(data.error ?? translate("You couldn't import the file."));
        const imported = data.edit as EditDocument;
        accept(imported);
        latest = imported;
        const target = imported.assets.at(-1)!;
        if (asReference) { guides.push(target); continue; }
        if (target.kind !== "document") {
          const inferred = !imported.clips.length && !imported.overlays.length && target.kind === "video" ? target.width > target.height ? "horizontal" : "vertical" : importFormat;
          importFormat = inferred;
          setFormat(inferred);
          const next = addAsset(target, imported);
          if (!(await save(next, { title: title.trim(), format: inferred }))) return;
          setSelected(next.clips.at(-1)!.id); setInspectorOpen(true); setTime(next.clips.at(-1)!.start);
        }
      }
      } finally { queued.forEach((f) => done(f.key)); }
      if (asReference && latest && guides.length) {
        const added = guides.map((asset) => fileReference(asset));
        const withReferences = { ...latest, references: [...latest.references, ...added] };
        // In the editor's state first: a save merges into what is on screen, which would otherwise drop them.
        setDoc(withReferences);
        const saved = await save(withReferences);
        if (!saved) return;
        const unread = await readReferenceScripts(saved, added.map((r) => r.id));
        setPanel("brand"); setLibraryOpen(true);
        setNotice(translate("{0}. Choose which guide each: visual style, script, brand or product. {1}", added.length === 1 ? translate("Reference added") : translate("{0} added references", added.length), unread ? translate(" You could not read the {0} script; try again from your card.", unread) : ""));
        return;
      }
      setNotice(translate("Imported files. Select a clip to cut it or add subtitles."));
    });
  }
  /**
   * Reads the script of video and audio references that guide a script: transcribes their sound and keeps
   * it as the reference's text, which is what the assistant follows. Returns how many could not be read.
   */
  async function readReferenceScripts(current: EditDocument, ids: string[]): Promise<number> {
    let next = current, failed = 0;
    for (const id of ids) {
      const reference = next.references.find((r) => r.id === id);
      const asset = reference && next.assets.find((a) => a.id === reference.assetId);
      if (!reference || !asset || !needsTranscript(reference, asset)) continue;
      setWorking(translate("Reading the \"{0}\" script... The first time the local model is downloaded.", reference.title));
      try {
        const response = await fetch(`/api/projects/${project.id}/analysis`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ assetId: asset.id, operation: "transcribe" }) });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error);
        const content = transcriptText(result.captions ?? []) || translate("No recognizable voice: guide yourself by your rhythm and your on-screen texts.");
        next = { ...next, references: next.references.map((r) => r.id === id ? { ...r, content } : r) };
      } catch { failed++; }
    }
    if (next !== current) {
      setDoc(next);
      if (!(await save(next))) return ids.length;
    }
    return failed;
  }
  function transcribeReference(id: string) {
    void perform(translate("Reading the reference script…"), async () => {
      if (dirty && !(await save())) return;
      if (await readReferenceScripts(doc, [id])) throw new Error(translate("The script of this reference could not be read."));
      setNotice(translate("Read script. The assistant will use it as a guide, with his own words."));
    });
  }
  function addText(kind: "text" | "caption" = "text", text?: string, style?: Partial<EditOverlay>) {
    const o = { ...newOverlay(text ?? (kind === "caption" ? translate("Write the subtitle") : translate("Your story starts here")), time >= total ? 0 : time, Math.max(0.04, Math.min(5, total - (time >= total ? 0 : time))), kind), ...style };
    setSelected(o.id); setInspectorOpen(true); change((d) => ({ ...d, duration: !d.clips.length && !d.overlays.length ? o.start + o.duration : d.duration, overlays: [...d.overlays, o] }));
  }
  function useRenderedVideo() {
    void perform(translate("Opening the video generated…"), async () => {
      if (dirty && !(await save())) return;
      const result = await loadRenderedVideoAction(project.id);
      if (!result.ok) throw new Error(result.error);
      accept(result.edit); setSelected(null); setTime(0);
    });
  }
  async function analyze(operation: "transcribe" | "silences" | "beats", targetId = selected) {
    const clip = doc.clips.find((c) => c.id === targetId);
    const asset = clip ? doc.assets.find((a) => a.id === clip.assetId) : undefined;
    if (!asset || !clip) return;
    await perform(operation === "transcribe" ? "Transcribiendo el audio. La primera vez se descarga el modelo local…" : operation === "silences" ? "Detectando silencios…" : "Detectando el ritmo…", async () => {
      const response = await fetch(`/api/projects/${project.id}/analysis`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ assetId: asset.id, operation }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      checkpoint();
      if (operation === "transcribe") {
        const targets = doc.clips.filter((c) => c.assetId === asset.id);
        // With word timings the subtitles follow the words that are in the montage, also after cutting phrases.
        const captions = result.words ? montageCaptions(doc, asset.id, result.words, doc.overlays.find((o) => o.kind === "caption")) : captionsForClips(result.captions, targets);
        setDoc({ ...doc, enabled: true, overlays: [...doc.overlays.filter((o) => o.kind !== "caption" || !targets.some((c) => o.start < c.start + c.duration && o.start + o.duration > c.start)), ...captions] });
        setPanel("captions"); setLibraryOpen(true); setNotice(translate("{0} synchronized subtitles. You can already correct them in the transcript.", captions.length));
      } else if (operation === "silences") {
        const ranges = keptRanges(result.log, clip.in, clip.duration, SILENCE_PAD);
        if (!ranges.length) throw new Error(translate("The complete clip was detected as silence. Adjust the cut manually."));
        if (ranges.length === 1 && Math.abs(ranges[0].duration - clip.duration) < 0.05) throw new Error(translate("There are no silences to remove in this clip."));
        const next = rippleSilences(doc, clip, ranges);
        const removed = clip.duration - ranges.reduce((sum, r) => sum + r.duration, 0);
        setDoc(next); setSelected(next.clips.find((c) => c.assetId === clip.assetId)?.id ?? null); setTime(Math.min(clip.start, editDuration(next))); setNotice(translate("{0} s of deleted silences. All tracks retain synchronization.", removed.toFixed(2)));
      } else {
        const synced = syncMusic(doc, clip, result.beats, result.bpm);
        const ms = (n: number) => `${Math.round(n * 1000)} ms`;
        setDoc(synced.doc);
        setNotice(synced.mode === "shift"
          ? translate("Music aligned to the cuts ({0} BPM): mean distance to the beat from {1} to {2}. {3} The voice and subtitles have not moved.", Math.round(synced.bpm), ms(synced.before), ms(synced.after), synced.ducked ? translate(" Volume down to 22% for voice to be heard.") : "")
          : translate("Chance-adjusted cuts ({0} BPM). Check the synchronization of the texts.", Math.round(synced.bpm)));
      }
    });
  }
  function removeSelected() {
    if (!selected) return;
    change((d) => removeItems(d, [selected], magnetic)); setSelected(null);
  }
  function undo() {
    if (locked || !history.length) return;
    setFuture((f) => [...f, doc]); setDoc({ ...history.at(-1)!, revision: doc.revision }); setHistory((h) => h.slice(0, -1));
  }
  function redo() {
    if (locked || !future.length) return;
    setHistory((h) => [...h, doc]); setDoc({ ...future.at(-1)!, revision: doc.revision }); setFuture((f) => f.slice(0, -1));
  }
  function seek(to: number) { const target = Math.max(0, Math.min(total, to)); setPlaying(false); setTime(target); if (viewGenerated && generatedVideo.current) { generatedVideo.current.pause(); generatedVideo.current.currentTime = target; } }
  const handleFocusScene = useCallback((index: number, estimatedSpan?: { start: number; duration: number }, force = true) => {
    const sceneNum = index + 1;
    let start = estimatedSpan?.start ?? 0;
    let end = start + (estimatedSpan?.duration ?? 0);

    if (doc.clips.length > 0) {
      const matchingClips = doc.clips.filter((c) => {
        const asset = doc.assets.find((a) => a.id === c.assetId);
        if (!asset) return false;
        if (new RegExp(translate("^ (?: Scene-124; Voiceover-124. Scene-12; Locution)\\ s + {0}\\ b", sceneNum), "i").test(asset.name)) return true;
        if (asset.context && new RegExp(translate("(?: Scene ¥124; Scene)\\ s + {0}\\ b", sceneNum), "i").test(asset.context)) return true;
        return false;
      });
      if (matchingClips.length > 0) {
        start = Math.min(...matchingClips.map((c) => c.start));
        end = Math.max(...matchingClips.map((c) => c.start + c.duration));
      }
    }

    const safeStart = Number.isFinite(start) ? Math.max(0, start) : 0;
    const safeEnd = Number.isFinite(end) ? Math.max(safeStart, end) : safeStart;

    if (!force && time >= safeStart && (safeEnd <= safeStart || time < safeEnd)) {
      return;
    }

    seek(safeStart);
  }, [doc.clips, doc.assets, time, total, viewGenerated]);
  function togglePlay() { if (viewGenerated && generatedVideo.current) { const video = generatedVideo.current; if (video.ended) video.currentTime = 0; if (video.paused) void video.play().catch(() => reportError(translate("The video could not be played."))); else video.pause(); } else { if (time >= total) setTime(0); setPlaying(!playing); } }
  function splitSelected() {
    if (!clip || locked) return;
    const parts = splitClip(clip, time);
    if (parts.length === 1) return;
    change((d) => ({ ...d, clips: d.clips.flatMap((c) => c.id === clip.id ? parts : [c]) }));
  }
  function duplicateSelected() {
    if (locked || (!clip && !overlay)) return;
    const id = crypto.randomUUID();
    if (overlay) {
      change((d) => ({ ...d, overlays: [...d.overlays, { ...overlay, id, x: Math.min(100 - overlay.width, overlay.x + 2), y: Math.min(90, overlay.y + 2) }] }));
    } else if (clip && clip.start + clip.duration * 2 <= 7200) {
      // The copy goes right after the original on its track; what follows there moves along to make room.
      const end = round(clip.start + clip.duration);
      change((d) => {
        const base = withTracks(d);
        const track = base.clips.find((c) => c.id === clip.id)?.track ?? 0;
        return moveItem({ ...base, clips: [...base.clips, { ...clip, id, start: end, track }] }, id, { start: end, track, at: end, push: true }, magnetic);
      });
      seek(clip.start + clip.duration);
    } else return;
    setSelected(id);
  }
  function exportVideo() {
    if (locked || running) return;
    if (!doc.clips.length && !doc.overlays.length) { goToScript(); return; }
    setExportError(null); setExportOpen(true);
  }
  function launchExport(quality: "draft" | "looks" | "delivery", target: ExportTarget | null) {
    void perform(translate("Preparing for export…"), async () => {
      if (!(await save())) { setExportError(translate("The changes could not be saved. Check the title and text of the assembly.")); return; }
      const result = await startVideoAction(project.id, { quality, format, source: "montage", ...target });
      if (!result.ok) { setExportError(result.error); return; }
      if ("videoId" in result) setLaunchedRun(result.videoId);
      setExportOpen(false);
      setNotice(target ? translate("Your video is being exported. At the end it will be stored in {0}.", target.saveTo) : translate("Your video is being exported. You can continue to review the assembly."));
    });
  }
  const onShortcut = useEffectEvent((e: KeyboardEvent) => {
    if (e.defaultPrevented || shortcutsOpen || document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
    // A key can also arrive with the window or the document as its target, which have no closest().
    const target = e.target instanceof Element ? e.target : null;
    const typing = !!target?.closest('input, textarea, select, [contenteditable="true"], [role="combobox"], [role="slider"]');
    const command = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (command && key === "s") { e.preventDefault(); if (!locked) void save(); return; }
    if (command && key === "o") { e.preventDefault(); if (!locked) uploadRef.current?.click(); return; }
    if (command && e.shiftKey && key === "e") { e.preventDefault(); exportVideo(); return; }
    if (typing) return;
    if (command && key === "z") { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
    if (command && key === "y") { e.preventDefault(); redo(); return; }
    if (command && key === "b") { e.preventDefault(); splitSelected(); return; }
    if (command && key === "d") { e.preventDefault(); duplicateSelected(); return; }
    if (command || e.altKey) return;
    if (e.code === "Space" && (!target?.closest('button, [role="button"], [role="tab"]') || target?.closest('[data-editor-overlay]'))) { e.preventDefault(); togglePlay(); }
    else if (e.key === "Delete" || e.key === "Backspace") { if (selected && !locked) { e.preventDefault(); removeSelected(); } }
    else if (e.key === "Escape") { setSelected(null); setPlaying(false); }
    else if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); seek(time + (e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 1 : 1 / 30)); }
    else if (e.key === "Home" || e.key === "End") { e.preventDefault(); seek(e.key === "Home" ? 0 : total); }
    else if (e.key === "?") { e.preventDefault(); setShortcutsOpen(true); }
    else if (key === "f") { e.preventDefault(); setFocusMode((f) => !f); }
  });
  useEffect(() => {
    const listener = (event: KeyboardEvent) => onShortcut(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);
  function selectElement(id: string | null, moveCursor = true) {
    setSelected(id); setPlaying(false);
    if (id) {
      setInspectorOpen(true);
      const element = doc.clips.find((c) => c.id === id) ?? doc.overlays.find((o) => o.id === id);
      if (element && moveCursor) setTime(element.start);
    }
  }
  function choosePanel(next: LibraryPanel) {
    if (panel === next && showLibrary) setLibraryOpen(false);
    else { setPanel(next); setLibraryOpen(true); }
  }
  function openImport(asReference = false, audioOnly = false) {
    if (locked) return;
    setReferenceOnly(asReference);
    if (uploadRef.current) {
      uploadRef.current.accept = audioOnly ? 'audio/*' : 'video/*,audio/*,image/png,image/jpeg,image/webp,.txt,.md,.json,.csv';
      uploadRef.current.click();
    }
  }
  /**
   * Adds a library file at `at`; dropped on a track of its kind, it goes on that track (where it fits, as a move would).
   * `base` is the document the clip goes into: the one on screen, or the one the server just returned when the
   * file joined the project a moment ago (the one on screen does not have that file yet, nor its revision).
   */
  function placeAsset(target: EditAsset, at?: number, lane?: { kind: TimelineKind; track: number; at: number } | null, base = doc) {
    if (target.kind === 'document') { setPanel('brand'); setLibraryOpen(true); return; }
    let next = addAsset(target, base, at);
    const id = next.clips.at(-1)!.id;
    if (lane && lane.kind === assetLane(target)) next = moveItem(next, id, { start: at ?? 0, track: lane.track, at: lane.at }, magnetic);
    next = withTracks(next);
    // Undo goes back to `base`, so the file stays in the library when only its clip is undone.
    if (base === doc) change(() => next);
    else { checkpoint(base); change(() => next, false); }
    const placed = next.clips.find((c) => c.id === id)!;
    setSelected(id); setTime(placed.start); setPlaying(false); setInspectorOpen(true);
  }
  function beginInteraction() { checkpoint(); setInteracting(true); setPlaying(false); }
  function endInteraction() { setInteracting(false); }
  function sendMessage() {
    if (!prompt.trim() || locked) return;
    void perform(translate("Preparing your changes…"), async () => {
      if (!(await save())) return;
      // The mode and the selected element are for the model; the chat shows only what the user wrote.
      const mode = doc.clips.length || doc.overlays.length ? translate("Editable timeline") : translate("Script and generation");
      const result = await sendAgentMessageAction(project.id, prompt, selected ? `${mode} · sobre el elemento ${selected}` : mode);
      if (!result.ok) throw new Error(result.error);
      setPrompt('');
    });
  }
  async function undoAssistant(messageId: string, edited: boolean, confirmed = false) {
    if (agent.busy || working) return;
    // The app's own dialog: native confirm() is not available in every desktop webview.
    if (edited && !confirmed) { setUndoAsk(messageId); return; }
    if (dirty && !(await save())) return;
    void perform('Deshaciendo los cambios del asistente…', async () => {
      const result = await undoAgentTurnAction(project.id, messageId, edited);
      if (!result.ok) throw new Error(result.error);
    });
  }
  /** The system share sheet with the exported MP4 itself; where the window has none, it falls back to saving the file. */
  async function shareLatest() {
    if (!latest?.url) return;
    const name = `${title.trim() || "VideoGen"}.mp4`;
    try {
      if (typeof navigator.share === "function" && typeof navigator.canShare === "function") {
        const blob = await fetch(latest.url).then((r) => { if (!r.ok) throw new Error(); return r.blob(); });
        const file = new File([blob], name, { type: "video/mp4" });
        if (navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: title.trim() }); return; }
      }
      await saveVideo(`${latest.url}&download=1`, name);
      setNotice(translate("This team does not offer to share directly: the MP4 has been saved for you to send."));
    } catch (e) {
      // Closing the share sheet is not an error.
      if (!(e instanceof DOMException && e.name === "AbortError")) setError(translate("You couldn't share the video."));
    }
  }
  /** Takes an unused file out of the project. Resolves to what went wrong, or null. */
  async function removeAsset(id: string): Promise<string | null> {
    if (locked) return translate("Wait until the current operation is over.");
    if (dirty && !(await save())) return translate("Save the changes before removing files.");
    const result = await removeAssetAction(project.id, id).catch(() => ({ ok: false as const, error: translate("You couldn't remove the file.") }));
    if (!result.ok) return result.error;
    accept(result.edit);
    setNotice(translate("File removed from the library."));
    return null;
  }
  async function handleAddGlobalAsset(globalAssetId: string) {
    if (locked) return;
    // The server adds the file to the saved project: pending changes go first so its answer does not replace them.
    if (dirty && !(await save())) return;
    try {
      const result = await addGlobalAssetToProjectAction(project.id, globalAssetId);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      accept(result.edit);
      // On the document that already has the file: the one drawn in this render is older.
      placeAsset(result.asset, undefined, null, result.edit);
      setNotice(translate("\"{0}\" added from the global library.", result.asset.name));
    } catch (e) {
      setError(e instanceof Error ? e.message : translate("Error when adding the file."));
    }
  }
  function goToScript() { setPanel("script"); setLibraryOpen(true); }
  function navigate(e: React.MouseEvent, href: string) {
    if (scriptDirty) { e.preventDefault(); e.stopPropagation(); goToScript(); setError(translate("Save the script changes before you go out.")); return; }
    if (!dirty && !saving && !locked) return;
    e.preventDefault(); e.stopPropagation();
    if (locked) return;
    void perform(translate("Saving before you go out…"), async () => { if (await save()) router.push(href); });
  }
  const activePanel = LIBRARY_PANELS.find((p) => p.id === panel)!;
  const canSplit = !!clip && time - clip.start >= 0.04 && clip.start + clip.duration - time >= 0.04;
  const empty = !doc.clips.length && !doc.overlays.length && !viewGenerated;
  const conflict = dirty && remoteRevision > doc.revision;
  const failedRun = project.videos[0]?.status === "error" && project.videos[0].id !== dismissedRun ? project.videos[0] : null;
  // The export launched here has finished: say once where it was saved, or why the copy outside the project failed.
  const finishedRun = launchedRun ? project.videos.find((v) => v.id === launchedRun && v.status === "done") : undefined;
  if (finishedRun) {
    setLaunchedRun(null);
    if (finishedRun.error) setError(finishedRun.error);
    else setNotice(finishedRun.savedPath ? translate("Video ready. Saving in {0}", finishedRun.savedPath) : translate("Video ready. Download it with \"Share › Download MP4.\""));
  }
  const message = error || saveError || failedRun?.error || notice;
  const rightOpen = assistantOpen || inspectorOpen;
  // The passes: one line above the chat (where the project is) and, while the agent is not working, the next
  // step right above the message box (what to press now). Both read the same project state.
  const passProps = { projectId: project.id, passes: project.passes, hasMontage: doc.clips.length > 0, busy: agent.busy, disabled: !!working, flush: async () => !dirty || !!(await save()), onRestored: (edit: EditDocument) => { checkpoint(); accept(edit); setSelected(null); } };
  const nextStep = passesShown(project.passes, doc.clips.length > 0) && !agent.busy
    ? <PassesNow {...passProps} onExport={exportVideo} onAsk={(text) => { setPrompt(text); setTimeout(() => document.querySelector<HTMLTextAreaElement>('.unified-agent textarea')?.focus(), 0); }} />
    : undefined;
  /** The agent and the inspector share the right column: one header with both tabs. */
  const sideTabs = (active: 'agent' | 'inspector') => <header><div className="unified-right-tabs" role="tablist" aria-label={translate("Sidebar")}><button type="button" role="tab" aria-selected={active === 'agent'} onClick={() => { setInspectorOpen(false); setAssistantOpen(true); }}>Chat{agent.busy && <i aria-hidden />}</button><button type="button" role="tab" aria-selected={active === 'inspector'} onClick={() => setInspectorOpen(true)}>Inspector</button></div><ToolButton icon="close" label={translate("Close Panel")} onClick={() => { setAssistantOpen(false); setInspectorOpen(false); }} /></header>;
  const renderLibrary = (targetPanel: LibraryPanel) => <WorkspaceLibrary projectId={project.id} panel={targetPanel} uploads={uploads} onRemoveAsset={removeAsset} onAddGlobalAsset={handleAddGlobalAsset} doc={doc} selected={selected} disabled={locked} agent={agent} prompt={prompt} onPrompt={setPrompt} onSend={sendMessage} onUndo={(id, edited) => void undoAssistant(id, edited)} onEffects={applyEffects} onImport={openImport} onAddAsset={placeAsset} onAddText={(text, style) => addText('text', text, style)} onSelect={(id) => selectElement(id)} onAnalyze={(operation, id) => void analyze(operation, id)} onImportCaptions={() => subtitleRef.current?.click()} onReference={(r) => change((d) => ({ ...d, references: [...d.references, r] }))} onRemoveReference={(id) => change((d) => ({ ...d, references: d.references.filter((r) => r.id !== id) }))} onUpdateReference={(id, update) => change((d) => ({ ...d, references: d.references.map((r) => r.id === id ? update(r) : r) }))} onTranscribeReference={transcribeReference} onUseReference={(text) => { setPrompt(text); setAssistantOpen(true); setInspectorOpen(false); }} time={time} onSeek={seek} onEditDoc={(update) => change(update)} />;

  return <div data-panel={panel} data-library-open={!focusMode && showLibrary} data-right-open={!focusMode && (assistantOpen || inspectorOpen)} data-library-auto={libraryOpen === null} data-side-auto={assistantChoice === null && !inspectorOpen} className={`pro-studio ${focusMode ? 'is-focused' : ''}`}
    onClickCapture={(e) => { const link = (e.target as HTMLElement).closest('a'); const href = link?.getAttribute('href'); if (href === '/' || href === `/projects/${project.id}/results`) navigate(e, href); }}
    onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); if (!locked) setDragFiles(true); } }}
    onDragLeave={(e) => { const r = e.currentTarget.getBoundingClientRect(); if (e.clientX <= r.left || e.clientX >= r.right || e.clientY <= r.top || e.clientY >= r.bottom) setDragFiles(false); }}
    onDrop={(e) => { if (e.dataTransfer.files.length) { e.preventDefault(); setDragFiles(false); if (!locked) void upload(Array.from(e.dataTransfer.files), false); } }}>
    <input ref={uploadRef} type="file" multiple accept="video/*,audio/*,image/png,image/jpeg,image/webp,.txt,.md,.json,.csv" className="hidden" aria-label={translate("Import Project Files")} onChange={(e) => { const files = Array.from(e.target.files ?? []); e.target.value = ''; if (files.length) { setPanel(referenceOnly ? 'brand' : 'media'); setLibraryOpen(true); void upload(files); } }} />
    <input ref={subtitleRef} type="file" accept=".srt,.vtt" className="hidden" aria-label={translate("Import subtitles")} onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void perform(translate("Importing subtitles…"), async () => { const captions = parseSubtitles(await file.text()); checkpoint(); setDoc({ ...doc, enabled: true, overlays: [...doc.overlays.filter((o) => o.kind !== 'caption'), ...captions] }); setPanel('captions'); setLibraryOpen(true); setNotice(translate("{0} imported subtitles. You can correct them in the transcript.", captions.length)); }); }} />
    <KeyboardHelp open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
    <ConfirmDialog open={!!undoAsk} onOpenChange={(open) => { if (!open) setUndoAsk(null); }} title={translate("Undo the agent changes?")}
      description={translate("You have changed the assembly after this response. By undoing it, you also miss those changes of yours.")} confirmLabel="Deshacer"
      onConfirm={() => { const id = undoAsk; setUndoAsk(null); if (id) void undoAssistant(id, true, true); }} />
    <ExportDialog key={exportQuality} defaultQuality={exportQuality} open={exportOpen} onOpenChange={setExportOpen} format={format} duration={total} clipCount={doc.clips.length} overlayCount={doc.overlays.length} disabled={locked || !!running} error={exportError} onExport={launchExport} fileName={`${title.trim() || "VideoGen"}.mp4`} exportFolder={exportFolder} />
    <header className="pro-topbar">
      <Link href="/" className="pro-back" aria-label={translate("Back to projects")}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="m15 5-7 7 7 7" /></svg><span>{translate("Projects")}</span></Link>
      <div className="pro-crumbs"><input aria-label={translate("Project name")} value={title} size={Math.max(8, Math.min(46, title.length + 1))} maxLength={80} disabled={locked} onChange={(e) => { setTitle(e.target.value); setSaveError(null); }} onBlur={() => { if (!title.trim()) setTitle(savedDetails.title); }} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { setTitle(savedDetails.title); e.currentTarget.blur(); } }} /></div>
      <PassChip passes={project.passes} busy={agent.busy} onOpen={() => { setInspectorOpen(false); setAssistantOpen(true); }} />
      <span className={`pro-save-status ${saveError ? 'has-error' : ''}`}>{saving ? <span className="pro-spinner" /> : <EditorIcon name={dirty ? 'save' : 'check'} />}<span>{saving ? translate("Saving…") : saveError ? translate("Error when saving") : dirty ? translate("Unsaved changes") : translate("Saved")}</span></span>
      <div className="pro-topbar-actions">
        <Menu><MenuTrigger asChild><Button className="pro-project-menu" size="icon-sm" aria-label={translate("Project options")}>•••</Button></MenuTrigger><MenuContent><MenuItem onSelect={() => void save()} disabled={locked}>{translate("Save now")}</MenuItem><MenuItem onSelect={goToScript} disabled={locked}>{translate("Script and generation")}</MenuItem><MenuItem onSelect={() => setShortcutsOpen(true)}>{translate("Keyboard shortcuts")}</MenuItem><MenuItem asChild><Link href="/library">{translate("Global library")}</Link></MenuItem><MenuItem asChild><Link href="/settings">{translate("App settings")}</Link></MenuItem>{project.videos.length > 0 && <MenuItem onSelect={() => choosePanel("exports")}>{translate("Previous exports")}</MenuItem>}<MenuSeparator /><MenuItem asChild><Link href="/">{translate("Back to projects")}</Link></MenuItem></MenuContent></Menu>
        <ToolButton icon="panel" label={rightOpen ? translate("Hide the side panel") : translate("Show the agent")} aria-pressed={rightOpen} onClick={() => { if (rightOpen) { setAssistantOpen(false); setInspectorOpen(false); } else setAssistantOpen(true); }} />
        <Menu><MenuTrigger asChild><Button variant="outline" size="sm" className="pro-download" disabled={!latest?.url}><EditorIcon name="export" /><span>{translate("Share")}</span></Button></MenuTrigger><MenuContent>
          <MenuItem icon={<EditorIcon name="export" />} onSelect={() => void shareLatest()}>{translate("Share the last MP4…")}</MenuItem>
          <MenuItem icon={<EditorIcon name="import" />} onSelect={() => { if (latest?.url) void saveVideo(`${latest.url}&download=1`, `${title}.mp4`).catch(() => setError(translate("You couldn't save the video."))); }}>{translate("Download MP4")}</MenuItem>
        </MenuContent></Menu>
        <Button variant="primary" size="sm" className="pro-export-button" disabled={locked || !!running || (empty && !project.scenes.length)} onClick={exportVideo}>{running ? 'Exportando…' : translate("Export")}</Button>
      </div>
    </header>
    {conflict && <div className="pro-conflict" role="alert"><span>{translate("The project changed in another session, your local changes are still here.")}</span><button onClick={() => { checkpoint(); accept(project.edit); setTitle(project.title); setFormat(project.format); setSavedDetails({ title: project.title, format: project.format }); setSaveError(null); }}>{translate("Load saved version")}</button></div>}
    <div className="pro-workbench">
      {!focusMode && <nav className="pro-tool-rail" aria-label={translate("Project tools")}>{LIBRARY_PANELS.filter((item) => item.id !== 'assistant').map((item) => <button key={item.id} type="button" aria-pressed={showLibrary && panel === item.id} onClick={() => choosePanel(item.id)}><span><EditorIcon name={item.icon} /></span><small>{item.label}</small></button>)}<div className="mt-auto" /><button type="button" onClick={() => setShortcutsOpen(true)} aria-label={translate("Keyboard shortcuts")}><span><EditorIcon name="keyboard" /></span><small>{translate("Shortcuts")}</small></button></nav>}
      <aside style={{ display: focusMode || !showLibrary ? "none" : undefined }} className="pro-library" aria-label={translate("Project library")}><header><strong>{activePanel.label}</strong>{(panel === 'media' || panel === 'audio') && <Button variant="primary" size="sm" className="pro-library-import" disabled={locked} onClick={() => openImport(false, panel === 'audio')}>{translate("Import")}<EditorIcon name="plus" /></Button>}</header>
        <div style={{ display: panel === "script" ? "contents" : "none" }}><ScriptTools project={project} tab={scriptTab} onTabChange={setScriptTab} onDirtyChange={setScriptDirty} disabled={locked || !!running} onLoadVideo={useRenderedVideo} onFocusScene={handleFocusScene} /></div>{panel === "exports" ? <ExportHistory project={project} disabled={locked || !!running} /> : panel !== "script" && renderLibrary(panel)}
      </aside>
      {!focusMode && (assistantOpen || inspectorOpen) && <SideResizer />}
      {!focusMode && assistantOpen && !inspectorOpen && <aside className="unified-agent" aria-label={translate("Studio assistant")}>{sideTabs('agent')}<PassesStrip {...passProps} /><AgentChat nextStep={nextStep} project={project} agent={agent} disabled={locked} selected={selected} prompt={prompt} onPrompt={setPrompt} onSend={sendMessage} onUndo={(id, edited) => void undoAssistant(id, edited)} onOpenScript={(tab) => { setScriptTab(tab); setPanel("script"); setLibraryOpen(true); }} onImport={() => openImport()} onOpenExports={() => choosePanel("exports")} onExport={exportVideo} hasMontage={doc.clips.length > 0} /></aside>}
      <main className="pro-stage" aria-label={translate("Timeline preview")}>
        <div className="pro-canvas-container">
          {viewGenerated && latest?.url ? <video key={latest.id} ref={generatedVideo} src={latest.url} playsInline preload="metadata" className="unified-render-preview" onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} onClick={togglePlay} /> : <EditCanvas doc={preview ?? doc} format={format} time={time} playing={playing} selected={selected} disabled={locked} guides={guides} zoom={canvasZoom === 'fit' ? null : Number(canvasZoom)} onSelect={(id) => selectElement(id, false)} onChange={(id, patch) => patchOverlay(id, patch, false)} onDragStart={beginInteraction} onDragEnd={endInteraction} onError={reportError} />}
          {selected && !empty && <div className="pro-floating-tools"><span>{overlay ? overlay.kind === 'caption' ? translate("Subtitle") : translate("Text") : asset?.kind === 'audio' ? 'Audio' : 'Clip'}</span><span className="editor-divider" />{clip && <ToolButton icon="split" label={translate("Divide in cursor")} shortcut="Ctrl / ⌘ B" disabled={locked || !canSplit} onClick={splitSelected} />}<ToolButton icon="duplicate" label={translate("Double selection")} shortcut="Ctrl / ⌘ D" disabled={locked} onClick={duplicateSelected} /><ToolButton icon="trash" label={translate("Remove Selection")} shortcut="Supr" disabled={locked} onClick={removeSelected} /><ToolButton icon="close" label={translate("Deselect")} onClick={() => setSelected(null)} /></div>}
          {running && <div className="unified-render-progress" role="status"><span className="pro-spinner" /><strong>{STAGES[running.stage ?? ""] ?? translate("Preparing the video")}</strong><span>{Math.round(running.progress)}%</span><button type="button" onClick={() => void cancelVideoAction(running.id)}>{translate("Cancel")}</button></div>}{dragFiles && <div className="pro-drop-overlay"><EditorIcon name="import" /><strong>{translate("Let go to import")}</strong><span>{translate("Your files are added to the project.")}</span></div>}
        </div>
        <div className="pro-transport"><div className="pro-transport-clock"><span>{clock(time)}</span><small>/ {clock(total)}</small></div><div className="pro-playback-buttons"><ToolButton icon="start" label={translate("Go to the beginning")} onClick={() => seek(0)} /><ToolButton icon="previous" label={translate("Previous frame")} shortcut="←" onClick={() => seek(time - 1 / 30)} /><ToolButton icon={playing ? 'pause' : 'play'} label={playing ? translate("Pausar assembly") : translate("Play assembly")} shortcut="Espacio" variant="primary" className="editor-tool pro-play" disabled={empty} onClick={togglePlay} /><ToolButton icon="next" label={translate("Next frame")} shortcut="→" onClick={() => seek(time + 1 / 30)} /><ToolButton icon="end" label={translate("Go to end")} onClick={() => seek(total)} /></div>
          <div className="pro-transport-side"><Select aria-label={translate("Project format")} value={format} disabled={locked} className="pro-format-select" size="sm" onValueChange={(v) => { setFormat(v as VideoFormat); setSaveError(null); }}><SelectItem value="vertical" hint="Vertical · 1080 × 1920">9:16</SelectItem><SelectItem value="horizontal" hint="Horizontal · 1920 × 1080">16:9</SelectItem></Select><Select aria-label={translate("Canvas zoom")} value={canvasZoom} className="pro-zoom-select" size="sm" onValueChange={setCanvasZoom}><SelectItem value="fit">{translate("Fit")}</SelectItem><SelectItem value="0.5">50%</SelectItem><SelectItem value="0.75">75%</SelectItem><SelectItem value="1">100%</SelectItem></Select><ToolButton icon="guides" label={translate("Show frame guides")} aria-pressed={guides} onClick={() => setGuides(!guides)} /><ToolButton icon="expand" label={focusMode ? translate("Exit focus mode") : translate("Focus mode")} shortcut="F" aria-pressed={focusMode} onClick={() => setFocusMode(!focusMode)} /></div></div>
      </main>
      {!focusMode && inspectorOpen && <aside className="pro-context-inspector" aria-label={translate("Properties inspector")}>{sideTabs('inspector')}<div className="pro-inspector-content">
        {(clip || overlay) && <div className="pro-selection-heading"><span><EditorIcon name={overlay ? overlay.kind === 'caption' ? 'captions' : 'text' : asset?.kind === 'audio' ? 'volume' : 'media'} /></span><div><strong>{overlay ? overlay.text.slice(0, 45) || translate("Text without content") : asset?.name}</strong><small>{(overlay?.duration ?? clip?.duration ?? 0).toFixed(2)}{translate("seconds")}</small></div></div>}
        {overlay ? <>
          <section className="pro-inspector-section"><label className="pro-label">{translate("Content")}<textarea aria-label={translate("Content of text")} value={overlay.text} rows={3} disabled={locked} maxLength={1000} aria-invalid={!overlay.text.trim()} onChange={(e) => patchOverlay(overlay.id, { text: e.target.value })} /></label><div className="grid grid-cols-2 gap-3"><NumberField label={translate("Size (px)")} value={overlay.fontSize} min={12} max={200} disabled={locked} onChange={(fontSize) => patchOverlay(overlay.id, { fontSize })} /><label className="pro-label">{translate("Alignment")}<Select aria-label={translate("Alignment of the text")} value={overlay.align} disabled={locked} onValueChange={(align) => patchOverlay(overlay.id, { align: align as EditOverlay['align'] })}><SelectItem value="left">{translate("Left")}</SelectItem><SelectItem value="center">{translate("Center")}</SelectItem><SelectItem value="right">{translate("Right")}</SelectItem></Select></label></div><ColorField label={translate("Text color")} value={overlay.color} disabled={locked} onChange={(color) => patchOverlay(overlay.id, { color })} /><div className="pro-background-control"><ColorField label={translate("Text background")} value={overlay.background} disabled={locked} onChange={(background) => patchOverlay(overlay.id, { background })} /><button type="button" disabled={locked} onClick={() => patchOverlay(overlay.id, { background: overlay.background === 'transparent' ? '#101018' : 'transparent' })}>{overlay.background === 'transparent' ? translate("Add Background") : 'Quitar fondo'}</button></div></section>
          <details className="pro-inspector-details" open><summary>{translate("Duration")}</summary><div className="grid grid-cols-2 gap-3"><NumberField label={translate("Home (s)")} value={overlay.start} max={7200 - overlay.duration} disabled={locked} onChange={(start) => patchOverlay(overlay.id, { start })} /><NumberField label={translate("Duration (s)")} value={overlay.duration} min={0.04} max={7200 - overlay.start} disabled={locked} onChange={(duration) => patchOverlay(overlay.id, { duration })} /></div></details>
          <details className="pro-inspector-details"><summary>{translate("Position and size")}</summary><div className="grid grid-cols-2 gap-3"><NumberField label={translate("Position X (%)")} value={overlay.x} max={100 - overlay.width} disabled={locked} onChange={(x) => patchOverlay(overlay.id, { x })} /><NumberField label={translate("Y position (%)")} value={overlay.y} max={100} disabled={locked} onChange={(y) => patchOverlay(overlay.id, { y })} /><NumberField label={translate("Width (%)")} value={overlay.width} min={5} max={100 - overlay.x} disabled={locked} onChange={(width) => patchOverlay(overlay.id, { width })} /></div><p>{translate("Drag the text to put on the canvas.")}</p></details>
          {overlay.kind === 'caption' && <Button variant="outline" size="sm" className="mx-4" disabled={locked} onClick={() => change((d) => ({ ...d, overlays: d.overlays.map((o) => o.kind === 'caption' ? { ...o, x: overlay.x, y: overlay.y, width: overlay.width, fontSize: overlay.fontSize, color: overlay.color, background: overlay.background, align: overlay.align } : o) }))}>{translate("Apply style to all subtitles")}</Button>}
        </> : clip && asset ? <>
          {asset.kind !== 'audio' && <section className="pro-inspector-section"><span className="pro-section-label">{translate("Encounter")}</span><div className="pro-fit-options">{([['contain',translate("Contain")],['cover',translate("Fill")]] as const).map(([fit,label]) => <button type="button" key={fit} aria-pressed={clip.fit === fit} disabled={locked} onClick={() => patchClip({ fit })}><span className={`pro-fit-diagram pro-fit-${fit}`} /><strong>{label}</strong></button>)}</div></section>}
          {asset.kind !== 'audio' && <section className="pro-inspector-section"><span className="pro-section-label">{translate("Entry transition")}</span><div className="pro-chip-options" role="group" aria-label={translate("Entry transition")}>{CLIP_TRANSITIONS.map((value) => <button type="button" key={value} aria-pressed={clip.transition === value} disabled={locked} onClick={() => patchClip({ transition: value })}>{TRANSITION_LABELS[value]}</button>)}</div><span className="pro-section-label">{translate("Camera movement")}</span><div className="pro-chip-options" role="group" aria-label={translate("Camera movement")}>{CLIP_MOTIONS.map((value) => <button type="button" key={value} aria-pressed={clip.motion === value} disabled={locked} onClick={() => patchClip({ motion: value })}>{MOTION_LABELS[value]}</button>)}</div>{asset.kind === 'video' && <><span className="pro-section-label">{translate("Speed")}</span><div className="pro-chip-options" role="group" aria-label={translate("Speed")}>{SPEED_CHOICES.map((value) => <button type="button" key={value} aria-pressed={(clip.speed ?? 1) === value} disabled={locked} onClick={() => applyEffects('selected', { speed: value })}>{speedLabel(value)}</button>)}</div></>}<button type="button" className="pro-smart-action" disabled={locked || doc.clips.length < 2} onClick={() => applyEffects('all', { transition: clip.transition, motion: clip.motion })}><EditorIcon name="sparkles" /><span>{translate("Apply to all clips")}</span></button></section>}
          {asset.hasAudio && <section className="pro-inspector-section"><VolumeField key={clip.id} value={clip.volume} onChange={(volume) => patchClip({ volume })} disabled={locked} /></section>}
          <details className="pro-inspector-details" open><summary>{translate("Duration and cutting")}</summary><div className="grid grid-cols-2 gap-3"><NumberField label={translate("Track start (s)")} value={clip.start} max={7200 - clip.duration} disabled={locked} onChange={(start) => patchClip({ start })} /><NumberField label={translate("Duration (s)")} value={clip.duration} min={0.04} max={asset.kind === 'image' ? 7200 - clip.start : asset.duration - clip.in} disabled={locked} onChange={(duration) => patchClip({ duration })} />{asset.kind !== 'image' && <NumberField label={translate("File input (s)")} value={clip.in} max={Math.max(0, asset.duration - 0.04)} disabled={locked} onChange={(v) => patchClip({ in: v, duration: Math.min(clip.duration, asset.duration - v) })} />}</div></details>
          {asset.hasAudio && <section className="pro-inspector-section"><span className="pro-section-label">{translate("Smart tools")}</span><button type="button" className="pro-smart-action" disabled={locked} onClick={() => void analyze('transcribe', clip.id)}><EditorIcon name="captions" /><span>{translate("Create subtitles")}<small>{translate("From original audio")}</small></span><span>↗</span></button><button type="button" className="pro-smart-action" disabled={locked} onClick={() => void analyze(asset.kind === 'audio' ? 'beats' : 'silences', clip.id)}><EditorIcon name="split" /><span>{asset.kind === 'audio' ? translate("Synchronize to the rhythm") : 'Quitar silencios'}<small>{translate("Keep the tracks synchronized")}</small></span><span>↗</span></button></section>}
        </> : <><div className="pro-no-selection"><span><EditorIcon name="settings" /></span><h3>{translate("Your project")}</h3><p>{translate("Select a clip or text to see your properties.")}</p></div><section className="pro-inspector-section"><ColorField label={translate("Canvas background")} value={doc.background} disabled={locked} onChange={(background) => change((d) => ({ ...d, background }))} /></section><details className="pro-inspector-details"><summary>{translate("Duration adjustments")}</summary><NumberField label={translate("Minimum duration (s)")} value={doc.duration} min={0.1} max={7200} disabled={locked} onChange={(duration) => change((d) => ({ ...d, duration }))} /><p>{translate("The video extends to the end of the last element.")}</p></details></>}
      </div></aside>}
      {message && <div className={`pro-toast ${error || saveError || failedRun ? 'is-error' : ''}`} role={error || saveError || failedRun ? 'alert' : 'status'}><EditorIcon name={error || saveError ? 'settings' : 'check'} /><span>{message}</span>{saveError ? <button type="button" onClick={() => void save()}>{translate("Retry")}</button> : <button type="button" aria-label={translate("Close notification")} onClick={() => { setError(null); setNotice(null); setDismissedRun(project.videos[0]?.id ?? null); }}><EditorIcon name="close" /></button>}</div>}
      {(working || (agent.busy && !(showLibrary && panel === 'assistant'))) && <div className="pro-operation-status" role="status"><span className="pro-spinner" /><span>{working || `${agent.step ?? translate("Preparing your changes")}…`}</span></div>}
    </div>
    {!focusMode && <StudioTimeline projectId={project.id} doc={doc} time={time} playing={playing} selected={selected} disabled={locked} magnetic={magnetic} onMagnetic={setMagnetic} onSelect={(id) => selectElement(id, false)} onSeek={seek} onBegin={() => setPlaying(false)} onPreview={setPreview} onCommit={(next, group) => change(() => next, true, group)} onAdd={(id, at, lane) => { const target = doc.assets.find((a) => a.id === id); if (target) placeAsset(target, at, lane); }} onImport={() => openImport()} onSplit={splitSelected} canSplit={canSplit} onUndo={undo} onRedo={redo} canUndo={!locked && history.length > 0} canRedo={!locked && future.length > 0} />}
    <footer className="pro-statusbar"><span>{focusMode ? translate("Focus mode · F to exit") : selected ? overlay ? translate("Double click to edit · Drag to move · Esc to unselect") : translate("Drag the ends of the clip to cut · Alt off the adjustment") : translate("All ready to create")}</span>{running ? <div className="pro-render-status"><span className="pro-spinner" /><span>{translate("Exporting")} {Math.round(running.progress)}%</span><progress value={running.progress} max={100} /><button onClick={() => void cancelVideoAction(running.id)}>{translate("Cancel")}</button></div> : latest?.url ? <button type="button" onClick={() => choosePanel("exports")}>{translate("Last video ready")} <span>↗</span></button> : <span>{doc.clips.length}{translate("clips ·")} {doc.overlays.length}{translate("layers")}</span>}</footer>
  </div>;
}

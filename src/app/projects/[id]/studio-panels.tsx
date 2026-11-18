"use client";

import { t as translate, localizedLabels } from "@/lib/i18n";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Dialog } from "radix-ui";
import { defaultExportPath, isDesktop, pickExportPath } from "@/lib/desktop";
import { Button } from "@/components/ui/button";
import { Select, SelectItem } from "@/components/ui/select";
import { referenceAssetIds, type EditAsset, type EditDocument, type EditOverlay, type EditReference } from "@/lib/editing/schema";
import { EFFECT_MOTIONS, type EffectMotion } from "@/lib/editing/effects";
import { CLIP_TRANSITIONS, MOTION_LABELS, SPEED_CHOICES, speedLabel, TRANSITION_LABELS, type ClipTransition } from "@/lib/editing/motion";
import { IMAGE_SECONDS } from "@/lib/editing/place";
import { ASSET_TYPE, assetKindType, assetSecondsType, shortTime } from "@/lib/editing/timeline";
import type { VideoFormat } from "@/lib/domain";
import type { AgentView } from "./studio";
import { EditorIcon, type EditorIconName } from "./desktop-controls";
import { ReferencesPanel } from "./references-panel";
import { AssetCard, UploadingCard, type UploadingFile } from "./asset-card";
import { fileReference } from "@/lib/editing/references";
import { GlobalAssetCard } from "@/app/library/global-asset-card";
import { CaptionHighlight, TranscriptPanel, type TranscriptView } from "./transcript-panel";
import type { GlobalAsset, GlobalAssetSource } from "@/lib/db/schema";
import Link from "next/link";

export type LibraryPanel = "media" | "script" | "text" | "captions" | "transitions" | "audio" | "brand" | "exports" | "assistant";
export const LIBRARY_PANELS: { id: LibraryPanel; label: string; icon: EditorIconName }[] = localizedLabels((translate) => ([
  { id: "media", label: translate("Library"), icon: "media" }, { id: "script", label: translate("Script"), icon: "script" }, { id: "text", label: translate("Text"), icon: "text" }, { id: "captions", label: translate("Subtitles"), icon: "captions" },
  { id: "transitions", label: translate("Transitions"), icon: "transition" }, { id: "audio", label: "Audio", icon: "music" }, { id: "brand", label: translate("References"), icon: "brand" }, { id: "exports", label: translate("Videos"), icon: "film" }, { id: "assistant", label: translate("Assistant"), icon: "sparkles" },
]));
const textPresets: { title: string; text: string; label: string; style: Partial<EditOverlay> }[] = localizedLabels((translate) => ([
  { title: translate("Title"), text: "Una gran historia.", label: "Grande y directo", style: { fontSize: 90, y: 30, align: "left", background: "transparent" } },
  { title: translate("Subtitle"), text: translate("Every detail counts."), label: translate("Add context"), style: { fontSize: 44, y: 55, background: "transparent" } },
  { title: translate("Highlights"), text: translate("This changes everything."), label: "Una idea que destaca", style: { fontSize: 64, background: "#adff77", color: "#121811", y: 40 } },
  { title: translate("Call to action"), text: translate("Find out now →"), label: "El siguiente paso", style: { fontSize: 44, background: "#b7b0ff", color: "#171326", y: 68 } },
]));
interface LibraryProps {
  projectId: string; panel: LibraryPanel; doc: EditDocument; selected: string | null; disabled: boolean; agent: AgentView;
  prompt: string; onUndo: (messageId: string, edited: boolean) => void; onEffects: (scope: "selected" | "all", change: { transition?: ClipTransition; motion?: EffectMotion; speed?: number }) => void; onPrompt: (value: string) => void; onSend: () => void; onImport: (referenceOnly?: boolean, audioOnly?: boolean) => void;
  onAddAsset: (asset: EditAsset) => void; onAddText: (text: string, style?: Partial<EditOverlay>) => void; onSelect: (id: string) => void;
  onAnalyze: (operation: "transcribe" | "silences" | "beats", clipId: string) => void; onImportCaptions: () => void;
  onReference: (reference: EditReference) => void; onRemoveReference: (id: string) => void; onUseReference: (message: string) => void;
  onUpdateReference: (id: string, update: (reference: EditReference) => EditReference) => void; onTranscribeReference: (id: string) => void;
  /** Files on their way up, shown first in the library. */
  uploads: UploadingFile[];
  /** Takes an unused file out of the project; resolves to an error message, or null. */
  onRemoveAsset: (id: string) => Promise<string | null>;
  onAddGlobalAsset?: (globalAssetId: string) => void;
  /** Playhead and seeking, for editing from the transcript. */
  time?: number; onSeek?: (time: number) => void;
  /** Applies a change to the montage with undo, for editing from the transcript. */
  onEditDoc?: (update: (doc: EditDocument) => EditDocument) => void;
}

const CAPTION_TABS: [TranscriptView | "captions", string][] = localizedLabels((translate) => ([["words", translate("Words")], ["cleanup", "Limpieza"], ["names", "Nombres"], ["captions", translate("Subtitles")]]));

const TRANSITION_HINTS: Record<ClipTransition, string> = localizedLabels((translate) => ({ cut: translate("Direct, no effect"), fade: translate("Get in from the bottom"), slide: translate("Enter from the right"), zoom: "Entra con un golpe de zoom" }));
const MOTION_HINTS: Record<EffectMotion, string> = localizedLabels((translate) => ({ none: translate("Fixed plane"), push: "Se acerca despacio", pull: "Se aleja despacio", alternate: "Alterna acercar y alejar" }));

/** How each clip arrives and moves: for the selected clip, or for all of them at once. */
function TransitionsPanel({ doc, selected, disabled, onEffects }: { doc: EditDocument; selected: string | null; disabled: boolean; onEffects: LibraryProps["onEffects"] }) {
  const clip = doc.clips.find((c) => c.id === selected && doc.assets.find((a) => a.id === c.assetId)?.kind !== "audio");
  const pictureClips = doc.clips.filter((c) => doc.assets.find((a) => a.id === c.assetId)?.kind !== "audio").length;
  const [scopeChoice, setScope] = useState<"selected" | "all">("selected");
  const scope = clip ? scopeChoice : "all";
  const off = disabled || pictureClips === 0;
  return <div className="pro-library-content pro-fx-panel">
    <p className="pro-fx-intro">{translate("Choose how each clip enters and if the camera moves. The effects last 0.3 s within the clip itself: they do not change the duration or audio.")}</p>
    <div className="pro-chip-options" role="group" aria-label={translate("Where to apply")}>
      <button type="button" aria-pressed={scope === "selected"} disabled={!clip} onClick={() => setScope("selected")}>{translate("Selected clip")}</button>
      <button type="button" aria-pressed={scope === "all"} onClick={() => setScope("all")}>{translate("All clips")}</button>
    </div>
    {pictureClips === 0 ? <p className="pro-fx-empty">{translate("Add videos or images to the timeline for transitions.")}</p> : !clip && <p className="pro-fx-empty">{translate("Select a clip in the timeline to change only that, or apply to all.")}</p>}
    <span className="pro-section-label">{translate("Entry transition")}</span>
    <div className="pro-fx-grid">{CLIP_TRANSITIONS.map((value) => <button type="button" key={value} className={`pro-fx-card pro-fx-${value}`} aria-pressed={scope === "selected" && clip?.transition === value} disabled={off} onClick={() => onEffects(scope, { transition: value })}>
      <span className="pro-fx-demo" aria-hidden><i /><b /></span><strong>{TRANSITION_LABELS[value]}</strong><small>{TRANSITION_HINTS[value]}</small>
    </button>)}</div>
    <span className="pro-section-label">{translate("Camera movement")}</span>
    <div className="pro-chip-options" role="group" aria-label={translate("Camera movement")}>{EFFECT_MOTIONS.map((value) => <button type="button" key={value} title={MOTION_HINTS[value]} aria-pressed={scope === "selected" && clip?.motion === value} disabled={off || (value === "alternate" && scope === "selected")} onClick={() => onEffects(scope, { motion: value })}>{value === "alternate" ? "Alternar" : MOTION_LABELS[value]}</button>)}</div>
    <span className="pro-section-label">{translate("Speed")}</span>
    <div className="pro-chip-options" role="group" aria-label={translate("Speed")}>{SPEED_CHOICES.map((value) => <button type="button" key={value} aria-pressed={scope === "selected" && (clip?.speed ?? 1) === value} disabled={off} onClick={() => onEffects(scope, { speed: value })}>{speedLabel(value)}</button>)}</div>
    <p className="pro-fx-note">{translate("The speed does not move the clips: each one retains its site and its duration and uses more or less material. It avoids speeding up clips with voice.")}</p>
    <p className="pro-fx-note">{translate("When applied to all, the first clip and the pieces that follow the same plane remain in cut.")}</p>
  </div>;
}

export function WorkspaceLibrary(p: LibraryProps) {
  const { panel, doc, disabled } = p;
  const [scope, setScope] = useState<"project" | "global">("project");
  const [globalAssets, setGlobalAssets] = useState<GlobalAsset[]>([]);
  const [globalSource, setGlobalSource] = useState<GlobalAssetSource | "all">("all");
  const [globalLoading, setGlobalLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");

  /** Switching to the global scope fetches it fresh: new renders and voices land there while you edit. */
  const showGlobal = () => {
    setScope("global");
    setGlobalLoading(true);
    fetch("/api/media/global")
      .then((res) => res.json())
      .then((data) => { if (data.assets) setGlobalAssets(data.assets); })
      .catch(() => {})
      .finally(() => setGlobalLoading(false));
  };

  // Reference files guide the assistant; they are not material for the cut, so the library leaves them out.
  const guides = referenceAssetIds(doc);
  const library = doc.assets.filter((a) => !guides.has(a.id));
  /** What this panel can show at all, and what the filter and the search leave of it. */
  const shelf = library.filter((a) => panel !== "audio" || a.kind === "audio");
  const shown = shelf.filter((a) => (panel === "audio" || filter === "all" || a.kind === filter) && a.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()));

  const shownGlobal = globalAssets.filter((a) => {
    if (panel === "audio" && a.kind !== "audio") return false;
    if (filter !== "all" && a.kind !== filter) return false;
    if (globalSource !== "all" && a.source !== globalSource) return false;
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      const matchName = a.name.toLowerCase().includes(q);
      const matchContext = a.context?.toLowerCase().includes(q);
      if (!matchName && !matchContext) return false;
    }
    return true;
  });

  const [captionSource, setCaptionSource] = useState("");
  const [captionTab, setCaptionTab] = useState<TranscriptView | "captions">("words");
  // One entry per file: cutting phrases splits a video into many clips, and they all share one transcript.
  const voiced = doc.clips.filter((c, i, all) => doc.assets.find((a) => a.id === c.assetId)?.hasAudio && all.findIndex((x) => x.assetId === c.assetId) === i);
  const selectedFile = doc.clips.find((c) => c.id === p.selected)?.assetId;
  const targetId = voiced.find((c) => c.id === captionSource)?.id ?? voiced.find((c) => c.assetId === selectedFile)?.id ?? voiced[0]?.id;
  const targetFile = voiced.find((c) => c.id === targetId)?.assetId;
  const captions = doc.overlays.filter((o) => o.kind === "caption");
  if (panel === "transitions") return <TransitionsPanel doc={doc} selected={p.selected} disabled={disabled} onEffects={p.onEffects} />;
  return <div className="pro-library-content">
    {(panel === "media" || panel === "audio") && <>
      <div className="pro-scope-tabs" role="group" aria-label={translate("Scope of the library")}>
        <button type="button" aria-pressed={scope === "project"} onClick={() => setScope("project")}>{translate("This project")} {library.length > 0 && `(${library.length})`}
        </button>
        <button type="button" aria-pressed={scope === "global"} onClick={showGlobal}>{translate("Global library")}</button>
      </div>

      {scope === "project" ? <>
        {panel === "media" && <div className="pro-filter-tabs" role="group" aria-label={translate("File type")}>{[["all", translate("All")], ["video", translate("Video")], ["image", translate("Image")], ["audio", "Audio"]].map(([value, label]) => <button type="button" key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}</button>)}</div>}
        {shelf.length > 0 && <div className="pro-search"><EditorIcon name="search" /><input aria-label={translate("Search the library")} value={query} onChange={(e) => setQuery(e.target.value)} placeholder={translate("Search…")} /></div>}
        {(shown.length > 0 || p.uploads.length > 0) && <div className="pro-asset-grid">{p.uploads.map((file) => <UploadingCard key={file.key} file={file} />)}{shown.map((asset) => <AssetCard key={asset.id} projectId={p.projectId} asset={asset} disabled={disabled} inUse={doc.clips.some((c) => c.assetId === asset.id)} onAdd={() => p.onAddAsset(asset)} onReference={() => p.onReference(fileReference(asset))} onRemove={() => p.onRemoveAsset(asset.id)} onDragStart={(e) => { e.dataTransfer.setData(ASSET_TYPE, asset.id); e.dataTransfer.setData(assetKindType(asset.kind === "audio" ? "audio" : "video"), "1"); e.dataTransfer.setData(assetSecondsType(asset.kind === "image" ? IMAGE_SECONDS : asset.duration), "1"); e.dataTransfer.effectAllowed = "copy"; }} />)}</div>}
        {!shelf.length && !p.uploads.length ? <div className="pro-panel-empty"><span><EditorIcon name={panel === "audio" ? "music" : "media"} /></span><p>{panel === "audio" ? translate("Give your story a sound") : translate("Create your library")}</p><small>{panel === "audio" ? translate("He goes up a song and asks the assistant to adjust the cuts to his rhythm; also voice or effects, with his volume in the inspector.") :translate("Start with your material: video, images, audio and documents. Then use it to shape your timeline.")}</small><button type="button" disabled={disabled} onClick={() => p.onImport(false, panel === "audio")}><EditorIcon name="export" />{panel === "audio" ? translate("Up audio") : translate("Up files")}</button>{panel === "audio" && <a className="pro-panel-link" href="https://pixabay.com/music/" target="_blank" rel="noreferrer">{translate("No song? Free music in Pixabay")}</a>}</div>
          : !shown.length ? <p className="pro-panel-note">{translate("Nothing matches your search.")}</p>
          : <p className="pro-panel-note">{translate("Drag a file to the timeline or press + to add it.")}</p>}
      </> : <>
        {panel === "media" && <div className="pro-filter-tabs" role="group" aria-label={translate("File type")}>{[["all", translate("All")], ["video", translate("Video")], ["image", translate("Image")], ["audio", "Audio"]].map(([value, label]) => <button type="button" key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}</button>)}</div>}
        <div className="pro-chip-options" role="group" aria-label={translate("Source")}>{[["all", translate("All")], ["upload", translate("Uploaded")], ["generated", translate("Generated")], ["stock", "Stock"]].map(([value, label]) => <button type="button" key={value} aria-pressed={globalSource === value} onClick={() => setGlobalSource(value as GlobalAssetSource | "all")}>{label}</button>)}</div>
        <div className="pro-search"><EditorIcon name="search" /><input aria-label={translate("Search the global library")} value={query} onChange={(e) => setQuery(e.target.value)} placeholder={translate("Search…")} /></div>
        {globalLoading ? <p className="pro-panel-note">{translate("Loading global library…")}</p> : shownGlobal.length > 0 ? (
          <div className="pro-asset-grid">
            {shownGlobal.map((asset) => {
              const inProject = doc.assets.some((a) => a.path === asset.path);
              return <GlobalAssetCard
                key={asset.id}
                asset={asset}
                disabled={disabled}
                inProject={inProject}
                onAddToProject={() => p.onAddGlobalAsset?.(asset.id)}
                onDelete={async () => {
                  const res = await fetch(`/api/media/global/${asset.id}`, { method: "DELETE" });
                  if (res.ok) setGlobalAssets((prev) => prev.filter((a) => a.id !== asset.id));
                  return res.ok ? null : translate("Error when eliminating");
                }}
              />;
            })}
          </div>
        ) : <p className="pro-panel-note">{translate("Nothing matches these filters.")}</p>}
        <Link href="/library" target="_blank" className="pro-panel-link" style={{ marginTop: 8, display: "inline-block" }}>{translate("Open library ↗")}</Link>
      </>}
    </>}
    {panel === "text" && <><p className="pro-panel-intro">{translate("Pick a starting point, then make it yours.")}</p><div className="pro-text-presets">{textPresets.map((preset, i) => <button type="button" key={preset.title} disabled={disabled} className={`pro-text-preset pro-text-preset-${i}`} onClick={() => p.onAddText(preset.text, preset.style)}><span className="pro-preset-preview">{preset.title}</span><span><strong>{preset.title}</strong><small>{preset.label}</small><EditorIcon name="plus" /></span></button>)}</div><p className="pro-panel-note">{translate("Double click on a text from the canvas to write. Drag to put it.")}</p></>}
    {panel === "captions" && <>
      <div className="pro-feature-intro"><span><EditorIcon name="captions" /></span><h3>{translate("It's been edited since it's been said.")}</h3><p>{translate("Remove phrases as if you delete text, clean breaks and repetitions, fix names and create synchronized subtitles.")}</p></div>
      {!!voiced.length && <label className="pro-label">{translate("Audio of origin")}<Select aria-label={translate("Audio for subtitles")} value={targetId} disabled={disabled} onValueChange={setCaptionSource}>{voiced.map((c, i) => <SelectItem key={c.id} value={c.id}>{i + 1}. {doc.assets.find((a) => a.id === c.assetId)?.name}</SelectItem>)}</Select></label>}
      {!!voiced.length && p.onEditDoc && <div className="pro-scope-tabs tx-tabs" role="group" aria-label={translate("What to do with the audio")}>{CAPTION_TABS.map(([id, label]) => <button type="button" key={id} aria-pressed={captionTab === id} onClick={() => setCaptionTab(id)}>{label}</button>)}</div>}
      {targetFile && p.onEditDoc && captionTab !== "captions" ? <TranscriptPanel key={targetFile} projectId={p.projectId} doc={doc} assetId={targetFile} view={captionTab} disabled={disabled} time={p.time ?? 0} onEdit={p.onEditDoc} onSeek={p.onSeek ?? (() => {})} onAsk={p.onUseReference} /> : <>
      <Button variant="primary" className="w-full justify-center" disabled={disabled || !targetId} onClick={() => targetId && p.onAnalyze("transcribe", targetId)}><EditorIcon name="sparkles" />{captions.length ? translate("Regenerate subtitles") : translate("Generate subtitles")}</Button>
      {!voiced.length && <p className="pro-panel-note">{translate("First add a voice video or audio to your assembly.")}</p>}
      <button className="pro-text-action" type="button" disabled={disabled} onClick={p.onImportCaptions}>{translate("Import SRT or VTT file")} <EditorIcon name="import" /></button>
      {!!captions.length && <><div className="pro-subsection-title">{translate("Assembly subtitles")} <span>{captions.length}</span></div><div className="pro-caption-list">{captions.map((o) => <button type="button" key={o.id} aria-pressed={o.id === p.selected} onClick={() => p.onSelect(o.id)}><span>{shortTime(o.start)}</span><p>{o.text}</p></button>)}</div></>}
      {!!captions.length && p.onEditDoc && <CaptionHighlight doc={doc} disabled={disabled} onEdit={p.onEditDoc} onAsk={p.onUseReference} />}
      </>}
    </>}
    {panel === "brand" && <ReferencesPanel projectId={p.projectId} doc={doc} disabled={disabled} onImport={() => p.onImport(true)} onAdd={p.onReference} onUpdate={p.onUpdateReference} onRemove={p.onRemoveReference} onTranscribe={p.onTranscribeReference} onUse={p.onUseReference} />}
  </div>;
}

/** Where the finished MP4 is also copied on this computer; `overwrite`: the system dialog already asked about replacing it. */
export type ExportTarget = { saveTo: string; overwrite: boolean };
const noSubscribe = () => () => {};

export function ExportDialog({ defaultQuality = "looks", open, onOpenChange, format, duration, clipCount, overlayCount, disabled, error, onExport, fileName, exportFolder }: { open: boolean; onOpenChange: (open: boolean) => void; format: VideoFormat; duration: number; clipCount: number; overlayCount: number; disabled: boolean; error: string | null; onExport: (quality: "draft" | "looks" | "delivery", target: ExportTarget | null) => void; defaultQuality?: "draft" | "looks" | "delivery"; fileName: string; exportFolder: string }) {
  const [quality, setQuality] = useState<"draft" | "looks" | "delivery">(defaultQuality);
  // Only the desktop app can write outside the project; a browser downloads the MP4 afterwards instead.
  const desktop = useSyncExternalStore(noSubscribe, isDesktop, () => false);
  const [picked, setPicked] = useState<ExportTarget | null>(null);
  const [fallback, setFallback] = useState<string | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);
  // Each opening starts from the last folder with a free name: a file picked (and confirmed) for one export is not replaced by the next.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) { setPicked(null); setPickError(null); }
  }
  useEffect(() => {
    if (!open || !desktop) return;
    let live = true;
    defaultExportPath(exportFolder, fileName).then((p) => { if (live) setFallback(p); }, () => { /* no Videos folder: the user picks one */ });
    return () => { live = false; };
  }, [open, desktop, exportFolder, fileName]);
  const target = picked ?? (fallback ? { saveTo: fallback, overwrite: false } : null);
  async function choose() {
    setPickError(null);
    try {
      const chosen = await pickExportPath(target?.saveTo ?? fileName);
      if (chosen) setPicked({ saveTo: chosen.path, overwrite: chosen.confirmed });
    } catch { setPickError(translate("The window could not be opened to choose folder.")); }
  }
  return <Dialog.Root open={open} onOpenChange={onOpenChange}><Dialog.Portal><Dialog.Overlay className="ui-overlay pro-dialog-overlay" /><Dialog.Content className="ui-pop ui-dialog pro-export-dialog">
    <div className="pro-export-heading"><span><EditorIcon name="export" /></span><Dialog.Close asChild><Button size="icon-sm" aria-label={translate("Close export")}><EditorIcon name="close" /></Button></Dialog.Close></div><Dialog.Title>{translate("Ready to share.")}</Dialog.Title><Dialog.Description>{translate("Export your assembly with the texts, cuts and audio you have prepared.")}</Dialog.Description>
    <div className="pro-export-summary"><strong>MP4</strong><span>{format === "vertical" ? "1080 × 1920 · 9:16" : "1920 × 1080 · 16:9"}</span><span>30 fps · {duration.toFixed(2)} s</span></div>
    <label className="pro-label">{translate("Quality")}<Select aria-label={translate("Export quality")} value={quality} onValueChange={(v) => setQuality(v as typeof quality)} disabled={disabled}><SelectItem value="draft" hint={translate("Faster, to review the assembly")}>{translate("Draft")}</SelectItem><SelectItem value="looks" hint={translate("Balanced quality and render time")}>{translate("Standard")}</SelectItem><SelectItem value="delivery" hint={translate("For your final delivery")}>{translate("Highest quality")}</SelectItem></Select></label>
    {desktop ? <div className="pro-label pro-export-target">{translate("Save in")}<div>{target ? <span title={target.saveTo}><strong>{target.saveTo.split(/[\\/]/).pop()}</strong><small>{target.saveTo.replace(/[\\/][^\\/]*$/, "")}</small></span> : <span><strong>{translate("Choose a folder from your computer")}</strong></span>}<Button size="sm" variant="outline" disabled={disabled} onClick={() => void choose()}>{target ? translate("Change…") : "Elegir…"}</Button></div>{pickError && <small role="alert" className="pro-export-error">{pickError}</small>}</div>
      : <p className="pro-export-detail">{translate("When you are finished, download it with \"Share › Download MP4\": it is saved in your browser's download folder.")}</p>}
    <p className="pro-export-detail">{clipCount}{translate("clips ·")} {overlayCount}{translate("texts and subtitles. Your original files are preserved.")}</p>{error && <p role="alert" className="pro-export-error">{error}</p>}
    <div className="pro-export-footer"><Button onClick={() => onOpenChange(false)} disabled={disabled}>{translate("Keep editing")}</Button><Button variant="primary" disabled={disabled} onClick={() => onExport(quality, desktop ? target : null)}><EditorIcon name="export" />{disabled ? "Preparando…" : translate("Export video")}</Button></div>
  </Dialog.Content></Dialog.Portal></Dialog.Root>;
}

"use client";

import { t as translate, localizedLabels } from "@/lib/i18n";
import { useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "@/components/ui/alert-dialog";
import { Button, IconButton } from "@/components/ui/button";
import { Select, SelectItem } from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { GlobalAsset, GlobalAssetKind, GlobalAssetSource } from "@/lib/db/schema";
import { EditorIcon } from "../projects/[id]/desktop-controls";
import { UploadingCard, type UploadingFile } from "../projects/[id]/asset-card";
import { GlobalAssetCard } from "./global-asset-card";
import "./library.css";

type KindFilter = GlobalAssetKind | "all";
type SourceFilter = GlobalAssetSource | "all";

const KINDS: [KindFilter, string][] = localizedLabels((translate) => ([
  ["all", translate("All")],
  ["video", translate("Video")],
  ["image", translate("Image")],
  ["audio", "Audio"],
  ["document", translate("Documents")],
]));

const SOURCES: [SourceFilter, string][] = localizedLabels((translate) => ([
  ["all", translate("Any source")],
  ["upload", translate("Uploaded")],
  ["generated", translate("AI-generated")],
  ["stock", "Stock"],
]));

const ACCEPT = "video/*,audio/*,image/png,image/jpeg,image/webp,.txt,.md,.json,.csv";

const uploadKind = (file: File): UploadingFile["kind"] =>
  file.type.startsWith("video/") ? "video" : file.type.startsWith("image/") ? "image" : file.type.startsWith("audio/") ? "audio" : "document";

/** A multipart POST that reports how much has gone up (fetch cannot). */
function postWithProgress(url: string, body: FormData, onProgress: (percent: number) => void) {
  return new Promise<{ ok: boolean; data: { asset?: GlobalAsset; error?: string } }>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress((e.loaded / e.total) * 100); };
    xhr.upload.onload = () => onProgress(100);
    xhr.onload = () => {
      try { resolve({ ok: xhr.status >= 200 && xhr.status < 300, data: JSON.parse(xhr.responseText) }); }
      catch { reject(new Error(translate("Unvalid server response."))); }
    };
    xhr.onerror = () => reject(new Error(translate("The connection was lost when the file was uploaded.")));
    xhr.send(body);
  });
}

interface UploadError { key: string; name: string; message: string }

export function LibraryView({ initialAssets }: { initialAssets: GlobalAsset[] }) {
  const [assets, setAssets] = useState<GlobalAsset[]>(initialAssets);
  const [kind, setKind] = useState<KindFilter>("all");
  const [source, setSource] = useState<SourceFilter>("all");
  const [query, setQuery] = useState("");
  const [uploads, setUploads] = useState<UploadingFile[]>([]);
  const [errors, setErrors] = useState<UploadError[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [bulkConfirm, setBulkConfirm] = useState(false);
  /** What the open confirmation is about, frozen when it opens so its text holds while it closes. */
  const [bulkTargets, setBulkTargets] = useState<GlobalAsset[]>([]);
  const [bulkPending, setBulkPending] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);
  /** Where the last plain click landed: Shift-click selects from here. */
  const anchorRef = useRef<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const uploadRef = useRef<(files: File[]) => void>(() => {});

  const pickFiles = () => inputRef.current?.click();

  const sync = async () => {
    setSyncing(true);
    setSyncError(null);
    try {
      const res = await fetch("/api/media/global?sync=1");
      const data = await res.json();
      if (!res.ok || !data.assets) throw new Error(data.error || translate("The library could not be updated."));
      setAssets(data.assets);
    } catch (e) {
      setSyncError(e instanceof Error ? e.message : translate("The library could not be updated."));
    } finally {
      setSyncing(false);
    }
  };

  const upload = async (files: File[]) => {
    if (!files.length) return;
    const queued: UploadingFile[] = files.map((file) => ({
      key: crypto.randomUUID(),
      name: file.name,
      progress: 0,
      kind: uploadKind(file),
      preview: /^(image|video)\//.test(file.type) ? URL.createObjectURL(file) : null,
    }));
    setUploads((prev) => [...queued, ...prev]);

    const setProgress = (key: string, progress: number) =>
      setUploads((prev) => prev.map((f) => (f.key === key ? { ...f, progress } : f)));
    const finish = (slot: UploadingFile) => {
      if (slot.preview) URL.revokeObjectURL(slot.preview);
      setUploads((prev) => prev.filter((f) => f.key !== slot.key));
    };

    // One at a time: the server converts each file with ffmpeg, and the order on screen stays the order picked.
    for (const [i, file] of files.entries()) {
      const slot = queued[i];
      const form = new FormData();
      form.set("file", file);
      try {
        const { ok, data } = await postWithProgress("/api/media/global", form, (p) => setProgress(slot.key, p));
        if (!ok || !data.asset) throw new Error(data.error || translate("You couldn't upload the file."));
        const asset = data.asset;
        setAssets((prev) => [asset, ...prev.filter((a) => a.id !== asset.id)]);
      } catch (e) {
        setErrors((prev) => [...prev, { key: slot.key, name: file.name, message: e instanceof Error ? e.message : translate("You couldn't upload the file.") }]);
      } finally {
        finish(slot);
      }
    }
  };
  useEffect(() => { uploadRef.current = (files) => void upload(files); });

  const remove = async (id: string): Promise<string | null> => {
    try {
      const res = await fetch(`/api/media/global/${id}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return data.error || translate("You couldn't remove the file.");
      setAssets((prev) => prev.filter((a) => a.id !== id));
      return null;
    } catch {
      return translate("You missed the connection, try again.");
    }
  };

  // Files can be dropped anywhere on the page. A depth counter, because dragenter/leave fire for every child crossed.
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes("Files");
    const enter = (e: DragEvent) => { if (!hasFiles(e)) return; depth++; setDragging(true); };
    const over = (e: DragEvent) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer!.dropEffect = "copy"; };
    const leave = (e: DragEvent) => { if (!hasFiles(e)) return; depth = Math.max(0, depth - 1); if (!depth) setDragging(false); };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length) uploadRef.current(files);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  }, []);

  const term = query.trim().toLocaleLowerCase();
  const filtering = kind !== "all" || source !== "all" || !!term;
  const shown = assets.filter((a) =>
    (kind === "all" || a.kind === kind) &&
    (source === "all" || a.source === source) &&
    (!term || a.name.toLocaleLowerCase().includes(term) || !!a.context?.toLocaleLowerCase().includes(term)),
  );
  const clearFilters = () => { setKind("all"); setSource("all"); setQuery(""); };

  // Bulk actions only reach what is on screen: a filter never hides something that is about to be deleted.
  const picked = shown.filter((a) => selected.has(a.id));
  const allPicked = shown.length > 0 && picked.length === shown.length;

  const exitSelection = () => { setSelecting(false); setSelected(new Set()); anchorRef.current = null; };
  const toggle = (id: string, e: React.MouseEvent) => {
    setSelecting(true);
    const anchor = anchorRef.current;
    const from = anchor ? shown.findIndex((a) => a.id === anchor) : -1;
    const to = shown.findIndex((a) => a.id === id);
    setSelected((prev) => {
      const next = new Set(prev);
      if (e.shiftKey && from >= 0 && to >= 0) {
        // A range takes the state of its anchor, like Finder.
        const on = prev.has(anchor!);
        for (const a of shown.slice(Math.min(from, to), Math.max(from, to) + 1)) { if (on) next.add(a.id); else next.delete(a.id); }
      } else if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    if (!e.shiftKey) anchorRef.current = id;
  };
  const toggleAll = () => setSelected(allPicked ? new Set() : new Set(shown.map((a) => a.id)));

  const removeSelected = async () => {
    const ids = bulkTargets.map((a) => a.id);
    setBulkPending(true);
    setBulkError(null);
    try {
      const res = await fetch("/api/media/global", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids }) });
      const data: { removed?: string[]; failed?: string[]; error?: string } = await res.json().catch(() => ({}));
      const gone = new Set(data.removed ?? []);
      setAssets((prev) => prev.filter((a) => !gone.has(a.id)));
      setSelected((prev) => new Set([...prev].filter((id) => !gone.has(id))));
      if (data.failed?.length) {
        setBulkError(data.failed.length === 1 ? translate("One file could not be removed.") : translate("{0} files could not be removed.", data.failed.length));
      } else if (!res.ok) {
        setBulkError(data.error || translate("The files could not be removed."));
      } else {
        setBulkConfirm(false);
        exitSelection();
      }
    } catch {
      setBulkError(translate("You missed the connection, try again."));
    } finally {
      setBulkPending(false);
    }
  };

  // Esc leaves selection mode; ⌘/Ctrl+A picks everything shown. Typing in a field is left alone.
  const selectAll = () => setSelected(new Set(shown.map((a) => a.id)));
  const keysRef = useRef({ exitSelection, selectAll });
  useEffect(() => { keysRef.current = { exitSelection, selectAll }; });
  useEffect(() => {
    if (!selecting) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest("input, textarea, [role='dialog'], [role='alertdialog'], [role='menu']")) return;
      if (e.key === "Escape") { e.preventDefault(); keysRef.current.exitSelection(); }
      else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a") { e.preventDefault(); keysRef.current.selectAll(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selecting]);

  return (
    <div className="library">
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={ACCEPT}
        hidden
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          void upload(files);
        }}
      />

      <header className="library-head">
        <div>
          <h1>{translate("Library")}{assets.length > 0 && <span>{assets.length}</span>}
          </h1>
          <p>{translate("Reuse uploaded and generated media across your projects.")}</p>
        </div>
        <div className="library-head-actions">
          <IconButton label={syncing ? translate("Looking for new files…") : translate("Find new files in your projects")} variant="glass" size="icon-sm" disabled={syncing} onClick={sync}>
            {syncing ? <span className="library-spinner" aria-hidden /> : (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" /></svg>
            )}
          </IconButton>
          {assets.length > 0 && (
            <Button variant="glass" size="sm" aria-pressed={selecting} onClick={() => (selecting ? exitSelection() : setSelecting(true))}>
              {selecting ? translate("Done") : translate("Select")}
            </Button>
          )}
          <Button variant="primary" size="sm" onClick={pickFiles}>
            <EditorIcon name="plus" />{translate("Upload files")}</Button>
        </div>
      </header>

      {assets.length > 0 && (
        <div className="library-toolbar">
          <ToggleGroup value={kind} onValueChange={setKind} aria-label={translate("File type")}>
            {KINDS.map(([value, label]) => <ToggleGroupItem key={value} value={value}>{label}</ToggleGroupItem>)}
          </ToggleGroup>
          <Select size="sm" value={source} onValueChange={(v) => setSource(v as SourceFilter)} aria-label={translate("Source")} className="library-source">
            {SOURCES.map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}
          </Select>
          <div className="library-search">
            <EditorIcon name="search" />
            <input
              type="search"
              className="ui-field"
              aria-label={translate("Search the library")}
              placeholder={translate("Search by name or content")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Escape" && query) { e.preventDefault(); setQuery(""); } }}
            />
            {query && (
              <button type="button" aria-label={translate("Delete Search")} onClick={() => setQuery("")}>
                <EditorIcon name="close" />
              </button>
            )}
          </div>
        </div>
      )}

      {(errors.length > 0 || syncError) && (
        <div className="library-notice" role="alert">
          <div>
            {syncError && <p>{syncError}</p>}
            {errors.length > 0 && <p>{errors.length === 1 ? translate("Could not upload 1 file:") : translate("No files could be uploaded {0}:", errors.length)}</p>}
            {errors.length > 0 && (
              <ul>
                {errors.map((e) => <li key={e.key}><strong>{e.name}</strong> · {e.message}</li>)}
              </ul>
            )}
          </div>
          <IconButton label={translate("Close Warning")} size="icon-sm" onClick={() => { setErrors([]); setSyncError(null); }}>
            <EditorIcon name="close" />
          </IconButton>
        </div>
      )}

      {uploads.length > 0 || shown.length > 0 ? (
        <section className="library-grid" aria-label={translate("Files")} aria-busy={uploads.length > 0}>
          {uploads.map((file) => <UploadingCard key={file.key} file={file} />)}
          {shown.map((asset) => (
            <GlobalAssetCard
              key={asset.id}
              asset={asset}
              previewOnClick
              selecting={selecting}
              selected={selected.has(asset.id)}
              onToggleSelect={(e) => toggle(asset.id, e)}
              onDelete={() => remove(asset.id)}
            />
          ))}
        </section>
      ) : filtering ? (
        <div className="library-empty">
          <span><EditorIcon name="search" /></span>
          <h2>{translate("No matches")}</h2>
          <p>{term ? <>{translate("There are no files that contain \"")}{query.trim()}{translate("” with these filters.")}</> : translate("No files with these filters.")}</p>
          <Button variant="outline" size="sm" onClick={clearFilters}>{translate("Clear filters")}</Button>
        </div>
      ) : (
        <div className="library-empty is-drop">
          <span><EditorIcon name="media" /></span>
          <h2>{translate("Your library is empty")}</h2>
          <p>{translate("Drag videos, images, audio or documents here. What you generate (voices, stock and final videos) will also appear here.")}</p>
          <Button variant="primary" size="sm" onClick={pickFiles}>
            <EditorIcon name="plus" />{translate("Upload files")}</Button>
        </div>
      )}

      {selecting && (
        <div className="library-bulk ui-material" role="toolbar" aria-label={translate("Actions with the selection")}>
          <span role="status" aria-live="polite">
            {picked.length === 0 ? translate("Choose files") : picked.length === 1 ? translate("1 selected") : translate("{0} selected", picked.length)}
          </span>
          <Button variant="ghost" size="sm" disabled={!shown.length} onClick={toggleAll}>
            {allPicked ? translate("Unchoose everything") : translate("Select All")}
          </Button>
          <Button variant="danger" size="sm" disabled={!picked.length} onClick={() => { setBulkError(null); setBulkTargets(picked); setBulkConfirm(true); }}>
            <EditorIcon name="trash" />
            {allPicked && picked.length > 1 ? translate("Remove everything") : translate("Remove")}
          </Button>
        </div>
      )}

      <ConfirmDialog
        open={bulkConfirm}
        onOpenChange={(open) => { if (!bulkPending) setBulkConfirm(open); }}
        title={bulkTargets.length === 1 ? translate("Remove \"{0}\" from the library?", bulkTargets[0].name) : translate("Remove {0} files from the library?", bulkTargets.length)}
        description={translate("They stop appearing in the library. The projects that already use them keep their copy. It can't be undone.")}
        confirmLabel={bulkTargets.length === 1 ? translate("Remove File") : translate("Remove {0}", bulkTargets.length)}
        pending={bulkPending}
        error={bulkError}
        onConfirm={() => void removeSelected()}
      />

      {dragging && (
        <div className="library-drop" aria-hidden>
          <strong>{translate("Release to add to the library")}</strong>
          <small>{translate("Video, image, audio or text · up to 256 MB per file")}</small>
        </div>
      )}
    </div>
  );
}

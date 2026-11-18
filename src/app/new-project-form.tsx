"use client";

import { t as translate, localizedLabels } from "@/lib/i18n";
import { useActionState, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, IconButton } from "@/components/ui/button";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/field";
import { Select, SelectItem } from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { VideoFormat } from "@/lib/domain";
import { AUDIO_FILE, MAX_IMPORT_FILES, planImport, VISUAL_FILE } from "@/lib/editing/import-plan";
import { DEFAULT_PRESET, PRESET_IDS, STYLE_PRESETS, type PresetId } from "@/presets";
import { attachReferencesAction, createProjectAction, createVideoProjectAction, importLibraryAssetAction, startHomeAgentAction, type CreateProjectState, type LibraryItem } from "./actions";
import { AgentModelPicker } from "./agent-model-picker";
import { REFERENCE_ACCEPT, ReferenceChip, ReferenceLibraryDialog, ReferenceMenu, WriteReferenceDialog, attachItem, fileDraft, type DraftReference } from "./home-references";
import { LibraryIcon, LibraryPickerDialog, libraryKey } from "./home-library";
import "./new-project-form.css";

const initialState: CreateProjectState = { error: null, topic: "" };

const EXAMPLES = localizedLabels((translate) => ([translate("Why the sky is blue"), translate("3 habits for better sleep"), translate("The history of coffee in 45 seconds"), translate("How a black hole works")]));
const EDIT_EXAMPLES = localizedLabels((translate) => ([translate("Make a 30-second reel with the best moments"), translate("Put them in order and add subtitles"), translate("Cut the silences and add music"), translate("Put together a before and after")]));

const ACCEPT = ".mp4,.mov,.m4v,.webm,.mkv,.png,.jpg,.jpeg,.webp,.mp3,.wav,.m4a,.ogg,.flac,.aac";

/**
 * A file waiting in the composer: one picked from this computer (with a local preview while it is there)
 * or one already in the library (with its cover), which goes into the project without uploading again.
 */
type Attachment = { key: string; name: string; kind: "video" | "image" | "audio"; url: string | null } & (
  | { source: "file"; file: File }
  | { source: "library"; assetId: string }
);

function kindOf(name: string): Attachment["kind"] | null {
  if (AUDIO_FILE.test(name)) return "audio";
  if (!VISUAL_FILE.test(name)) return null;
  return /\.(png|jpe?g|webp)$/i.test(name) ? "image" : "video";
}

/**
 * The home composer: one prompt bar for every way to start. Type an idea and the
 * agent makes the video. Attach your own files (the "+" menu, the upload button,
 * dropping or pasting them on the bar) and the prompt becomes what to do with
 * them: they go into a new project and the agent edits them. Or open an empty
 * canvas in the chosen format.
 */
export function NewProjectForm() {
  const router = useRouter();
  const [state, formAction, pending] = useActionState(createProjectAction, initialState);
  const [topic, setTopic] = useState(state.topic);
  const [preset, setPreset] = useState<PresetId>(DEFAULT_PRESET);
  const [format, setFormat] = useState<VideoFormat>("vertical");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState<{ label: string; done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Some files made it in and some did not: the project exists, so the user decides whether to open it. */
  const [partial, setPartial] = useState<{ id: string; notes: string[]; mode: "create" | "edit" } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [references, setReferences] = useState<DraftReference[]>([]);
  const [writingReference, setWritingReference] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [mediaLibraryOpen, setMediaLibraryOpen] = useState(false);
  const referenceFileRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const formRef = useRef<HTMLFormElement>(null);
  const blankRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const urlsRef = useRef(new Set<string>());
  const [creating, setCreating] = useState(false);
  const busy = pending || uploading || creating;
  const editing = attachments.length > 0;

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [topic]);

  /** Set once a launch hands off to the editor: the next time the page hides, the composer starts over. */
  const launched = useRef(false);

  // With Cache Components the home page is hidden (not unmounted) while the editor is open, so on "back"
  // its state would return: the old files, references and prompt, and a spinner stuck on the last step.
  // Once a launch has gone through, empty the composer as the page hides. A draft left without launching
  // stays as it was, previews included (so they are not freed on hide).
  useLayoutEffect(() => () => {
    if (!launched.current) return;
    launched.current = false;
    urlsRef.current.forEach((u) => URL.revokeObjectURL(u));
    urlsRef.current.clear();
    setAttachments([]); setReferences([]); setTopic("");
    setProgress(null); setError(null); setPartial(null);
    setUploading(false); setCreating(false);
  }, []);

  // The plain-topic and blank-canvas launches go through the form action: if it answers with an error
  // instead of redirecting, nothing was launched.
  useEffect(() => { if (state.error) launched.current = false; }, [state]);

  function attach(picked: File[]) {
    if (busy) return;
    setError(null); setPartial(null);
    const supported = picked.filter((f) => kindOf(f.name));
    if (supported.length === 0) { setError(translate("Admitted formats: video (MP4, MOV, M4V, WebM, MKV), image (PNG, JPG, WebP) and audio (MP3, WAV, M4 A, OGG, FLAC, AAC).")); return; }
    const skipped = picked.length - supported.length;
    const known = new Set(attachments.map((a) => a.key));
    const fresh = supported.filter((file) => {
      const key = `${file.name}:${file.size}:${file.lastModified}`;
      if (known.has(key)) return false;
      known.add(key);
      return true;
    });
    const room = MAX_IMPORT_FILES - attachments.length;
    if (fresh.length > room) setError(translate("You can import up to {0} files at once.", MAX_IMPORT_FILES));
    else if (skipped) setError(translate("{0} file {1} with unadmitted format was omitted {2}.", skipped, skipped === 1 ? "" : "s", skipped === 1 ? "" : "ieron"));
    const added: Attachment[] = fresh.slice(0, Math.max(0, room)).map((file) => {
      const kind = kindOf(file.name)!;
      const url = kind === "audio" ? null : URL.createObjectURL(file);
      if (url) urlsRef.current.add(url);
      return { key: `${file.name}:${file.size}:${file.lastModified}`, source: "file", file, name: file.name, kind, url };
    });
    if (added.length) setAttachments([...attachments, ...added]);
    inputRef.current?.focus();
  }

  /** Files picked from the library join the attachments as they are: nothing to upload, just their place in the order. */
  function attachFromLibrary(picked: LibraryItem[]) {
    if (busy) return;
    setError(null); setPartial(null);
    const known = new Set(attachments.map((a) => a.key));
    const fresh = picked.filter((item) => !known.has(libraryKey(item.id)));
    const room = MAX_IMPORT_FILES - attachments.length;
    if (fresh.length > room) setError(translate("You can import up to {0} files at once.", MAX_IMPORT_FILES));
    const added: Attachment[] = fresh.slice(0, Math.max(0, room)).map((item) => ({ key: libraryKey(item.id), source: "library", assetId: item.id, name: item.name, kind: item.kind, url: item.thumbnail }));
    if (added.length) setAttachments([...attachments, ...added]);
    inputRef.current?.focus();
  }

  function detach(key: string) {
    const gone = attachments.find((a) => a.key === key);
    if (gone?.source === "file" && gone.url) { URL.revokeObjectURL(gone.url); urlsRef.current.delete(gone.url); }
    setAttachments(attachments.filter((a) => a.key !== key));
    setError(null);
  }

  function addReferences(drafts: DraftReference[]) {
    setError(null);
    const known = new Set(references.map((r) => r.key));
    const fresh = drafts.filter((d) => !known.has(d.key));
    const room = Math.max(0, 40 - references.length);
    if (fresh.length > room) setError(translate("You can add up to 40 references."));
    for (const d of fresh.slice(room)) if (d.source === "file" && d.preview) URL.revokeObjectURL(d.preview);
    const added = fresh.slice(0, room);
    for (const d of added) if (d.source === "file" && d.preview) urlsRef.current.add(d.preview);
    if (added.length) setReferences([...references, ...added]);
  }

  function removeReference(key: string) {
    const gone = references.find((r) => r.key === key);
    if (gone?.source === "file" && gone.preview) { URL.revokeObjectURL(gone.preview); urlsRef.current.delete(gone.preview); }
    setReferences(references.filter((r) => r.key !== key));
  }

  /**
   * Puts the composer's references into the new project: uploads reference files (as files of the
   * project, not on the timeline) and then attaches all of them. Returns what could not be added.
   */
  async function attachDraftReferences(id: string, mode: "create" | "edit"): Promise<string[]> {
    if (!references.length) return [];
    const notes: string[] = [];
    const items: NonNullable<ReturnType<typeof attachItem>>[] = [];
    for (const [i, draft] of references.entries()) {
      let assetId: string | undefined;
      if (draft.source === "file") {
        setProgress({ label: translate("By raising {0} reference to {1} · {2}", i + 1, references.length, draft.file.name), done: i, total: references.length });
        try {
          const body = new FormData(); body.set("file", draft.file);
          const response = await fetch(`/api/projects/${id}/media`, { method: "POST", body });
          const data = await response.json();
          if (!response.ok) throw new Error(data.error);
          assetId = data.edit.assets.at(-1)?.id;
        } catch (e) {
          notes.push(`${draft.file.name}: ${e instanceof Error ? e.message : translate("He couldn't get on.")}`);
          continue;
        }
      }
      const item = attachItem(draft, assetId);
      if (item) items.push(item);
    }
    setProgress({ label: translate("By keeping references…"), done: references.length, total: references.length });
    const result = await attachReferencesAction(id, items, mode).catch(() => ({ error: translate("The references could not be added."), skipped: [] as string[] }));
    if (result.error) notes.push(result.error);
    for (const skipped of result.skipped) notes.push(translate("It could not be copied {0}.", skipped));
    return notes;
  }

  /** Opens the new project, handing the typed instruction (if any) to the agent first. */
  async function openProject(id: string, mode: "create" | "edit" = "edit") {
    const instruction = topic.trim();
    if (instruction) {
      setProgress({ label: "Preparando al asistente…", done: 1, total: 1 });
      // A failure here is not fatal: the editor opens and shows it in its conversation.
      await startHomeAgentAction(id, instruction, mode).catch(() => null);
    }
    launched.current = true;
    router.push(`/projects/${id}`);
  }

  /** A video written by the agent, with references: the project first, then its references, then the agent. */
  async function submitCreateWithReferences() {
    setError(null); setPartial(null); setCreating(true);
    setProgress({ label: translate("Creating the project…"), done: 0, total: 1 });
    const created = await createVideoProjectAction({ topic, preset, format }).catch(() => ({ ok: false as const, error: translate("The project could not be created.") }));
    if (!created.ok) { setProgress(null); setError(created.error); setCreating(false); return; }
    const notes = await attachDraftReferences(created.id, "create");
    if (notes.length) { setProgress(null); setPartial({ id: created.id, notes, mode: "create" }); setCreating(false); return; }
    await openProject(created.id, "create");
  }

  /**
   * Imports the attached files into a new project. Each goes up in its own request (so each has its own
   * 256 MB limit and a progress line): the first creates the project, the rest are added to it and placed
   * on the timeline. Videos and images follow in the order chosen; audio goes last, as music under them.
   * Files from the library are not uploaded: the project uses the library's copy.
   */
  async function submitImport() {
    if (busy) return;
    setError(null); setPartial(null);
    const plan = planImport(attachments);
    if (!plan.ok) { setError(plan.error); return; }
    const { ordered } = plan;
    setUploading(true);
    let id: string | null = null;
    const notes: string[] = [];
    for (const [i, item] of ordered.entries()) {
      const verb = item.source === "library" ? translate("Adding") : "Subiendo";
      setProgress({ label: ordered.length > 1 ? `${verb} ${i + 1} de ${ordered.length} · ${item.name}` : `${verb} ${item.name}`, done: i, total: ordered.length });
      try {
        if (item.source === "library") {
          const result = await importLibraryAssetAction(id, item.assetId);
          if (!result.ok) throw new Error(result.error);
          id ??= result.id;
          continue;
        }
        const body = new FormData(); body.set("file", item.file);
        const response = await fetch(id ? `/api/projects/${id}/media?place=1` : "/api/projects/import", { method: "POST", body });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error);
        id ??= data.id as string;
      } catch (e) {
        notes.push(`${item.name}: ${e instanceof Error ? e.message : translate("It couldn't be imported.")}`);
      }
    }
    if (!id) { setProgress(null); setError(notes.join(" · ")); setUploading(false); return; }
    notes.push(...(await attachDraftReferences(id, "edit")));
    if (notes.length) { setProgress(null); setPartial({ id, notes, mode: "edit" }); setUploading(false); return; }
    setProgress({ label: "Abriendo el editor…", done: ordered.length, total: ordered.length });
    await openProject(id);
  }

  function submit() {
    if (busy) return;
    if (editing) void submitImport();
    else if (!topic.trim()) inputRef.current?.focus();
    else if (references.length) void submitCreateWithReferences();
    else formRef.current?.requestSubmit();
  }

  const shownError = error || state.error;
  const canSend = !busy && (editing || topic.trim().length > 0);

  return (
    <div className="flex w-full max-w-[760px] flex-col gap-3">
      <form
        ref={formRef}
        action={formAction}
        onSubmit={(e) => {
          // Only a plain topic goes to the form action; files, references or an empty prompt take the
          // client paths (and never the browser's own "fill out this field" bubble).
          if (editing || references.length || !topic.trim()) { e.preventDefault(); submit(); }
          else launched.current = true;
        }}
        noValidate
        className="prompt-bar composer relative flex flex-col gap-2 rounded-[22px] p-2.5 text-left"
        data-dragging={dragging || undefined}
        onDragEnter={(e) => {
          if (!e.dataTransfer.types.includes("Files")) return;
          e.preventDefault(); dragDepth.current++; setDragging(true);
        }}
        onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) e.preventDefault(); }}
        onDragLeave={() => { if (--dragDepth.current <= 0) { dragDepth.current = 0; setDragging(false); } }}
        onDrop={(e) => {
          e.preventDefault(); dragDepth.current = 0; setDragging(false);
          const files = Array.from(e.dataTransfer.files);
          if (files.length) attach(files);
        }}
      >
        {editing && (
          <ul className="composer-files" aria-label={translate("Attachments")}>
            {attachments.map((a) => (
              <li key={a.key} className="composer-file" title={a.source === "library" ? translate("{0} · from your library", a.name) : a.name}>
                <span className="composer-thumb" aria-hidden>
                  {a.url && (a.kind === "image" || a.source === "library") ? (
                    // eslint-disable-next-line @next/next/no-img-element -- local blob preview or library cover
                    <img src={a.url} alt="" />
                  ) : a.kind === "video" && a.url ? (
                    <video src={`${a.url}#t=0.1`} muted playsInline preload="metadata" />
                  ) : (
                    <AudioIcon />
                  )}
                  {a.kind === "video" && <span className="composer-thumb-badge"><PlayIcon /></span>}
                </span>
                <span className="composer-file-name">{a.name}</span>
                {!uploading && (
                  <button type="button" className="composer-file-remove" aria-label={`Quitar ${a.name}`} onClick={() => detach(a.key)}>
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" aria-hidden><path d="M6 6l12 12M18 6L6 18" /></svg>
                  </button>
                )}
              </li>
            ))}
            {!uploading && attachments.length < MAX_IMPORT_FILES && (
              <li>
                <button type="button" className="composer-file-add" aria-label={translate("Add more files")} onClick={() => fileRef.current?.click()}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden><path d="M12 5v14M5 12h14" /></svg>
                </button>
              </li>
            )}
          </ul>
        )}
        {references.length > 0 && (
          <div className="home-ref-tray" role="list" aria-label={translate("References")}>
            {references.map((r) => (
              <div role="listitem" key={r.key}>
                <ReferenceChip draft={r} disabled={busy} onRoles={(roles) => setReferences(references.map((x) => x.key === r.key ? { ...x, roles } : x))} onRemove={() => removeReference(r.key)} />
              </div>
            ))}
          </div>
        )}
        <Label htmlFor="new-topic" className="sr-only">
          {editing ? translate("What to do with your files") : translate("Describe the video")}
        </Label>
        <textarea
          id="new-topic"
          ref={inputRef}
          name="topic"
          rows={2}
          maxLength={2000}
          value={topic}
          autoFocus
          readOnly={uploading}
          onChange={(e) => setTopic(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          onPaste={(e) => {
            const files = Array.from(e.clipboardData.files);
            if (files.length) { e.preventDefault(); attach(files); }
          }}
          placeholder={editing ? translate("What do we do with your files? Ej.: a 30 s reel with the best and subtitles") : translate("Describe the video you want to create…")}
          aria-describedby={shownError ? "new-topic-error" : "new-topic-hint"}
          className="max-h-[180px] min-h-[56px] w-full resize-none bg-transparent px-3 pt-2 text-base leading-6 outline-none placeholder:text-muted/80 focus-visible:shadow-none read-only:opacity-60"
        />
        <input type="hidden" name="preset" value={preset} />
        <input type="hidden" name="format" value={format} />
        <input hidden multiple type="file" ref={referenceFileRef} accept={REFERENCE_ACCEPT} onChange={(e) => {
          const files = Array.from(e.target.files ?? []); e.target.value = "";
          const drafts = files.map(fileDraft).filter((d): d is DraftReference => d !== null);
          if (drafts.length < files.length) setError(translate("Some files do not have an admitted format and have been omitted."));
          addReferences(drafts);
        }} />
        <input hidden multiple type="file" ref={fileRef} accept={ACCEPT} onChange={(e) => { const files = Array.from(e.target.files ?? []); e.target.value = ""; if (files.length) attach(files); }} />

        {progress && (
          <div className="composer-progress" role="status" aria-live="polite">
            <span className="truncate">{progress.label}</span>
            <span className="composer-progress-track" aria-hidden>
              <span style={{ width: `${Math.max(6, (progress.done / progress.total) * 100)}%` }} />
            </span>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-1.5">
          <Menu>
            <MenuTrigger asChild disabled={busy}>
              <Button variant="glass" size="icon" aria-label={translate("More ways to start")} className="composer-plus">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
                  <path d="M12 5v14M5 12h14" />
                </svg>
              </Button>
            </MenuTrigger>
            <MenuContent align="start" side="bottom" className="min-w-[260px]">
              <MenuItem icon={<UploadIcon />} onSelect={() => fileRef.current?.click()}>
                <span className="flex flex-col">
                  <span>{translate("Edit my videos")}</span>
                  <span className="text-xs text-muted">{translate("Attached video, image or music and tell me what to do")}</span>
                </span>
              </MenuItem>
              <MenuItem icon={<LibraryIcon />} onSelect={() => setMediaLibraryOpen(true)}>
                <span className="flex flex-col">
                  <span>{translate("Using my library")}</span>
                  <span className="text-xs text-muted">{translate("What you already went up or generated, without going back up")}</span>
                </span>
              </MenuItem>
              <MenuSeparator />
              <MenuItem icon={<CanvasIcon />} onSelect={() => { launched.current = true; blankRef.current?.requestSubmit(); }}>
                <span className="flex flex-col">
                  <span>{translate("Blank canvas")}</span>
                  <span className="text-xs text-muted">{translate("Open the empty editor in")} {format === "vertical" ? "9:16" : "16:9"}</span>
                </span>
              </MenuItem>
            </MenuContent>
          </Menu>
          <span className="composer-divider" aria-hidden />
          {editing ? (
            <span className="composer-mode">
              <UploadIcon />{translate("Edit")} {attachments.length}{translate("file")}{attachments.length === 1 ? "" : "s"}
            </span>
          ) : (
            <>
              <Select
                size="sm"
                aria-label={translate("Style")}
                value={preset}
                onValueChange={(v) => setPreset(v as PresetId)}
                className="!w-auto !border-transparent !bg-foreground/[0.05] !shadow-none hover:!bg-foreground/[0.09]"
                leading={<span aria-hidden className="h-2.5 w-2.5 flex-none rounded-full" style={{ background: STYLE_PRESETS[preset].accent }} />}
              >
                {PRESET_IDS.map((id) => (
                  <SelectItem key={id} value={id} hint={STYLE_PRESETS[id].hint}>
                    {STYLE_PRESETS[id].label}
                  </SelectItem>
                ))}
              </Select>
              <ToggleGroup<VideoFormat> aria-label={translate("Format")} value={format} onValueChange={setFormat}>
                <ToggleGroupItem value="vertical">9:16</ToggleGroupItem>
                <ToggleGroupItem value="horizontal">16:9</ToggleGroupItem>
              </ToggleGroup>
            </>
          )}
          <ReferenceMenu count={references.length} disabled={busy} onUpload={() => referenceFileRef.current?.click()} onWrite={() => setWritingReference(true)} onLibrary={() => setLibraryOpen(true)} />
          <span className="flex-1" />
          <IconButton
            variant="ghost"
            label={translate("Use files from my library")}
            tooltipSide="top"
            disabled={busy || attachments.length >= MAX_IMPORT_FILES}
            onClick={() => setMediaLibraryOpen(true)}
            className="text-muted hover:text-foreground"
          >
            <LibraryIcon />
          </IconButton>
          {!editing && (
            <IconButton
              variant="ghost"
              label={translate("Attach files to edit")}
              tooltipSide="top"
              disabled={busy}
              onClick={() => fileRef.current?.click()}
              className="text-muted hover:text-foreground"
            >
              <UploadIcon />
            </IconButton>
          )}
          <AgentModelPicker side="bottom" />
          <Button
            type="submit"
            variant="primary"
            size="icon-lg"
            aria-label={editing ? translate("Upload and edit") : translate("Create with AI")}
            disabled={!canSend}
            className="!rounded-full"
          >
            {busy ? (
              <span className="typing-dot" />
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M5 12h14M13 6l6 6-6 6" />
              </svg>
            )}
          </Button>
        </div>

        {dragging && (
          <div className="composer-drop" aria-hidden>
            <UploadIcon />
            <strong>{translate("Release to attach your files")}</strong>
            <small>{translate("Video, image and music · up")} {MAX_IMPORT_FILES}{translate("files")}</small>
          </div>
        )}
      </form>

      <WriteReferenceDialog open={writingReference} onOpenChange={setWritingReference} onAdd={(d) => addReferences([d])} />
      <ReferenceLibraryDialog open={libraryOpen} onOpenChange={setLibraryOpen} taken={new Set(references.map((r) => r.key))} onAdd={addReferences} />
      <LibraryPickerDialog open={mediaLibraryOpen} onOpenChange={setMediaLibraryOpen} taken={new Set(attachments.map((a) => a.key))} room={MAX_IMPORT_FILES - attachments.length} onAdd={attachFromLibrary} />

      {/* The empty canvas skips the prompt: its own form. */}
      <form ref={blankRef} action={formAction} hidden>
        <input name="workspace" value="blank" readOnly />
        <input name="format" value={format} readOnly />
      </form>

      {shownError ? (
        <p id="new-topic-error" role="alert" className="text-sm text-danger">
          {shownError}
        </p>
      ) : (
        <p id="new-topic-hint" className="sr-only">{translate("Drop or paste videos into the box to edit them.")}</p>
      )}
      {partial && (
        <div role="alert" className="space-y-2 text-left text-sm">
          <p className="text-danger">{translate("Some files were not imported:")}</p>
          <ul className="list-disc pl-5 text-danger">{partial.notes.map((n) => <li key={n}>{n}</li>)}</ul>
          <Button variant="primary" onClick={() => void openProject(partial.id, partial.mode)}>{translate("Open editor anyway")}</Button>
        </div>
      )}

      <ul className="flex flex-wrap justify-center gap-2" aria-label={translate("Examples")}>
        {(editing ? EDIT_EXAMPLES : EXAMPLES).map((example) => (
          <li key={example}>
            <Button
              variant="chip"
              size="none"
              disabled={busy}
              onClick={() => {
                setTopic(example);
                inputRef.current?.focus();
              }}
            >
              {example}
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function UploadIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 15V4M7 9l5-5 5 5M5 15v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3" />
    </svg>
  );
}

function CanvasIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
      <path d="M3.5 15.5l4.5-4 4 3.5 3-2.5 5 4" />
    </svg>
  );
}

function AudioIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M9 18V5l11-2v13" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="17" cy="16" r="3" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg width="8" height="8" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M7 4.5v15l13-7.5z" />
    </svg>
  );
}

"use client";

import { t as translate } from "@/lib/i18n";
import { useEffect, useMemo, useState } from "react";
import { Dialog as D } from "radix-ui";
import { Button } from "@/components/ui/button";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/dropdown-menu";
import type { AttachItem, ReusableReference } from "@/lib/editing/reference-library";
import { REFERENCE_ROLE_INFO, defaultReferenceRoles } from "@/lib/editing/references";
import { REFERENCE_ROLES, type EditAsset, type ReferenceRole } from "@/lib/editing/schema";
import { listReferenceLibraryAction } from "./actions";
import "./home-references.css";

/** A reference waiting in the home composer until the project exists. */
export type DraftReference = { key: string; title: string; roles: ReferenceRole[] } & (
  | { source: "file"; file: File; kind: EditAsset["kind"]; preview: string | null }
  | { source: "text"; content: string; url: string }
  | { source: "existing"; projectId: string; referenceId: string; kind: ReusableReference["kind"]; thumbnail: string | null }
);

export const REFERENCE_ACCEPT = ".mp4,.mov,.m4v,.webm,.mkv,.png,.jpg,.jpeg,.webp,.mp3,.wav,.m4a,.ogg,.flac,.aac,.txt,.md,.json,.csv";

export function referenceKind(name: string): EditAsset["kind"] | null {
  if (/\.(mp4|mov|m4v|webm|mkv)$/i.test(name)) return "video";
  if (/\.(png|jpe?g|webp)$/i.test(name)) return "image";
  if (/\.(mp3|wav|m4a|ogg|flac|aac)$/i.test(name)) return "audio";
  if (/\.(txt|md|json|csv)$/i.test(name)) return "document";
  return null;
}

/** A reference file picked in the composer, with the default roles for its kind and a local preview. */
export function fileDraft(file: File): DraftReference | null {
  const kind = referenceKind(file.name);
  if (!kind) return null;
  return {
    key: `file:${file.name}:${file.size}:${file.lastModified}`, source: "file", file, kind,
    title: file.name.replace(/\.[^.]+$/, "").trim().slice(0, 160) || translate("Reference"), roles: defaultReferenceRoles(kind),
    preview: kind === "video" || kind === "image" ? URL.createObjectURL(file) : null,
  };
}

/** What to send for a draft once its file (if any) is uploaded to the new project. */
export function attachItem(draft: DraftReference, uploadedAssetId?: string): AttachItem | null {
  if (draft.source === "text") return { source: "text", title: draft.title, content: draft.content, url: draft.url, roles: draft.roles };
  if (draft.source === "existing") return { source: "existing", projectId: draft.projectId, referenceId: draft.referenceId, roles: draft.roles };
  return uploadedAssetId ? { source: "file", assetId: uploadedAssetId, roles: draft.roles } : null;
}

const rolesSummary = (roles: ReferenceRole[]) => roles.map((r) => REFERENCE_ROLE_INFO[r].label).join(" · ");

/** The composer's "Referencia" button: upload one, write one, or reuse one from another project. */
export function ReferenceMenu({ count, disabled, onUpload, onWrite, onLibrary }: { count: number; disabled: boolean; onUpload: () => void; onWrite: () => void; onLibrary: () => void }) {
  return <Menu>
    <MenuTrigger asChild disabled={disabled}>
      <button type="button" className="home-ref-trigger" aria-label={translate("Add references")}>
        <CubeIcon />
        <span>{translate("References")}</span>
        {count > 0 && <b>{count}</b>}
      </button>
    </MenuTrigger>
    <MenuContent align="start" className="min-w-[280px]">
      <p className="home-ref-menu-intro">{translate("They guide the assistant without entering the video: a style, a script, your brand, your product.")}</p>
      <MenuItem icon={<UploadIcon />} onSelect={onUpload}>
        <span className="flex flex-col"><span>{translate("Up reference")}</span><span className="text-xs text-muted">{translate("A video you like, catch, a script…")}</span></span>
      </MenuItem>
      <MenuItem icon={<PenIcon />} onSelect={onWrite}>
        <span className="flex flex-col"><span>{translate("Write or paste a link")}</span><span className="text-xs text-muted">{translate("Your brand, your product, a script")}</span></span>
      </MenuItem>
      <MenuSeparator />
      <MenuItem icon={<LibraryIcon />} onSelect={onLibrary}>
        <span className="flex flex-col"><span>{translate("Use an existing")}</span><span className="text-xs text-muted">{translate("From your other projects")}</span></span>
      </MenuItem>
    </MenuContent>
  </Menu>;
}

/** One reference in the composer tray: what it is, what it guides; its menu changes the roles or removes it. */
export function ReferenceChip({ draft, disabled, onRoles, onRemove }: { draft: DraftReference; disabled: boolean; onRoles: (roles: ReferenceRole[]) => void; onRemove: () => void }) {
  const image = draft.source === "file" ? draft.preview : draft.source === "existing" ? draft.thumbnail : null;
  const kind = draft.source === "text" ? "text" : draft.kind;
  return <Menu>
    <MenuTrigger asChild disabled={disabled}>
      <button type="button" className="home-ref-chip" title={`${draft.title} · ${rolesSummary(draft.roles)}`}>
        <span className="home-ref-chip-thumb" aria-hidden>
          {image ? kind === "video" && draft.source === "file"
            ? <video src={`${image}#t=0.1`} muted playsInline preload="metadata" />
            // eslint-disable-next-line @next/next/no-img-element -- local preview or project thumbnail
            : <img src={image} alt="" />
            : <KindIcon kind={kind} />}
        </span>
        <span className="home-ref-chip-text">
          <strong>{draft.title}</strong>
          <small>{rolesSummary(draft.roles)}</small>
        </span>
      </button>
    </MenuTrigger>
    <MenuContent align="start" className="min-w-[240px]">
      <p className="home-ref-menu-intro">{translate("What a guide \"")}{draft.title}»</p>
      {REFERENCE_ROLES.map((role) => {
        const on = draft.roles.includes(role);
        return <MenuItem key={role} icon={on ? <CheckIcon /> : <span />} onSelect={(e) => {
          e.preventDefault();
          if (on && draft.roles.length === 1) return;
          onRoles(on ? draft.roles.filter((r) => r !== role) : REFERENCE_ROLES.filter((r) => r === role || draft.roles.includes(r)));
        }}>
          <span className="flex flex-col"><span>{REFERENCE_ROLE_INFO[role].label}</span><span className="text-xs text-muted">{REFERENCE_ROLE_INFO[role].hint}</span></span>
        </MenuItem>;
      })}
      <MenuSeparator />
      <MenuItem destructive icon={<CloseIcon />} onSelect={onRemove}>{translate("Remove Reference")}</MenuItem>
    </MenuContent>
  </Menu>;
}

function RoleToggles({ roles, onChange }: { roles: ReferenceRole[]; onChange: (roles: ReferenceRole[]) => void }) {
  return <div className="home-ref-roles" role="group" aria-label={translate("What a guide")}>
    {REFERENCE_ROLES.map((role) => <button key={role} type="button" title={REFERENCE_ROLE_INFO[role].hint} aria-pressed={roles.includes(role)} onClick={() => {
      const on = roles.includes(role);
      if (on && roles.length === 1) return;
      onChange(on ? roles.filter((r) => r !== role) : REFERENCE_ROLES.filter((r) => r === role || roles.includes(r)));
    }}>{REFERENCE_ROLE_INFO[role].label}</button>)}
  </div>;
}

/** Writes a reference by hand: a name, what it guides, a link and/or its text. */
export function WriteReferenceDialog({ open, onOpenChange, onAdd }: { open: boolean; onOpenChange: (open: boolean) => void; onAdd: (draft: DraftReference) => void }) {
  const [title, setTitle] = useState("");
  const [roles, setRoles] = useState<ReferenceRole[]>(["brand"]);
  const [url, setUrl] = useState("");
  const [content, setContent] = useState("");
  const validUrl = !url.trim() || /^https?:\/\/\S+$/.test(url.trim());
  const ready = title.trim() && (content.trim() || url.trim()) && validUrl;
  return <D.Root open={open} onOpenChange={onOpenChange}>
    <D.Portal>
      <D.Overlay className="ui-overlay fixed inset-0 z-50 bg-transparent" />
      <D.Content className="ui-pop ui-dialog fixed left-1/2 top-1/2 z-50 w-[min(480px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-[18px] p-6">
        <form className="home-ref-form" onSubmit={(e) => {
          e.preventDefault();
          if (!ready) return;
          onAdd({ key: `text:${crypto.randomUUID()}`, source: "text", title: title.trim(), roles, url: url.trim(), content });
          setTitle(""); setRoles(["brand"]); setUrl(""); setContent(""); onOpenChange(false);
        }}>
          <D.Title className="text-lg font-semibold tracking-tight">{translate("New reference")}</D.Title>
          <D.Description className="text-sm text-muted">{translate("The assistant will follow you as you guide.")}</D.Description>
          <input autoFocus aria-label={translate("Name")} maxLength={160} value={title} onChange={(e) => setTitle(e.target.value)} placeholder={translate("Name (e.g. \"Brand Guide\")")} />
          <RoleToggles roles={roles} onChange={setRoles} />
          <input aria-label={translate("Link")} type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder={translate("Link (optional)")} aria-invalid={!validUrl} />
          <textarea aria-label={translate("Text")} rows={5} maxLength={16000} value={content} onChange={(e) => setContent(e.target.value)} placeholder={roles.includes("script") ? translate("Paste the script or describe its structure…") : "Colores, mensajes, pantallas, lo que debe notarse…"} />
          {!validUrl && <p className="text-xs text-danger">{translate("The link must start with http:// or https://")}</p>}
          <div className="flex justify-end gap-2">
            <D.Close asChild><Button variant="ghost">{translate("Cancel")}</Button></D.Close>
            <Button type="submit" variant="primary" disabled={!ready}>{translate("Add")}</Button>
          </div>
        </form>
      </D.Content>
    </D.Portal>
  </D.Root>;
}

/** Picks references saved in other projects; they are copied (with their file) into the new one. */
export function ReferenceLibraryDialog({ open, onOpenChange, taken, onAdd }: { open: boolean; onOpenChange: (open: boolean) => void; taken: Set<string>; onAdd: (drafts: DraftReference[]) => void }) {
  const [items, setItems] = useState<ReusableReference[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const keyOf = (r: ReusableReference) => `existing:${r.projectId}:${r.referenceId}`;

  // Reload on every opening: references may have been added in the editor since.
  useEffect(() => {
    if (!open) return;
    let live = true;
    listReferenceLibraryAction()
      .then((list) => { if (live) { setItems(list); setError(null); } })
      .catch(() => { if (live) setError(translate("You couldn't load your references.")); });
    return () => { live = false; };
  }, [open]);
  const close = (next: boolean) => { if (!next) { setPicked(new Set()); setQuery(""); } onOpenChange(next); };

  const shown = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    return (items ?? []).filter((r) => !q || `${r.title} ${r.projectTitle} ${r.excerpt}`.toLocaleLowerCase().includes(q));
  }, [items, query]);

  return <D.Root open={open} onOpenChange={close}>
    <D.Portal>
      <D.Overlay className="ui-overlay fixed inset-0 z-50 bg-transparent" />
      <D.Content className="ui-pop ui-dialog home-ref-library fixed left-1/2 top-1/2 z-50 w-[min(720px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-[18px] p-6">
        <D.Title className="text-lg font-semibold tracking-tight">{translate("Your references")}</D.Title>
        <D.Description className="text-sm text-muted">{translate("Choose the ones you want to reuse. They are copied to the new project.")}</D.Description>
        <input className="home-ref-search" aria-label={translate("Find references")} value={query} onChange={(e) => setQuery(e.target.value)} placeholder={translate("Search by name or project…")} />
        <div className="home-ref-grid">
          {error ? <p className="home-ref-empty text-danger">{error}</p>
            : items === null ? <p className="home-ref-empty">{translate("Loading…")}</p>
            : shown.length === 0 ? <p className="home-ref-empty">{items.length ? translate("None of them match your search.") : translate("You still have no references. Add one from the editor or upload it right here.")}</p>
            : shown.map((r) => {
              const key = keyOf(r);
              const already = taken.has(key);
              const on = picked.has(key) || already;
              return <button key={key} type="button" className="home-ref-card" aria-pressed={on} disabled={already} onClick={() => setPicked((p) => { const n = new Set(p); if (n.has(key)) n.delete(key); else n.add(key); return n; })}>
                <span className="home-ref-card-thumb">
                  {/* eslint-disable-next-line @next/next/no-img-element -- project thumbnail */}
                  {r.thumbnail ? <img src={r.thumbnail} alt="" loading="lazy" /> : <KindIcon kind={r.kind} />}
                  {on && <span className="home-ref-card-check"><CheckIcon /></span>}
                </span>
                <strong>{r.title}</strong>
                <small>{rolesSummary(r.roles)}</small>
                <em>{r.projectTitle}</em>
              </button>;
            })}
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <D.Close asChild><Button variant="ghost">{translate("Cancel")}</Button></D.Close>
          <Button variant="primary" disabled={!picked.size} onClick={() => {
            const chosen = (items ?? []).filter((r) => picked.has(keyOf(r)));
            onAdd(chosen.map((r) => ({ key: keyOf(r), source: "existing", projectId: r.projectId, referenceId: r.referenceId, title: r.title, roles: r.roles, kind: r.kind, thumbnail: r.thumbnail })));
            close(false);
          }}>{picked.size ? translate("Add {0}", picked.size) : translate("Add")}</Button>
        </div>
      </D.Content>
    </D.Portal>
  </D.Root>;
}

function KindIcon({ kind }: { kind: ReusableReference["kind"] }) {
  if (kind === "audio") return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M9 18V5l11-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="17" cy="16" r="3" /></svg>;
  if (kind === "text" || kind === "document") return <PenIcon />;
  return <CubeIcon />;
}
function CubeIcon() {
  return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z" /><path d="M4 7.5l8 4.5 8-4.5M12 12v9" /></svg>;
}
function UploadIcon() {
  return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 15V4M7 9l5-5 5 5M5 15v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3" /></svg>;
}
function PenIcon() {
  return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4" /></svg>;
}
function LibraryIcon() {
  return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><rect x="3.5" y="4" width="7" height="7" rx="1.5" /><rect x="13.5" y="4" width="7" height="7" rx="1.5" /><rect x="3.5" y="14" width="7" height="7" rx="1.5" /><rect x="13.5" y="14" width="7" height="7" rx="1.5" /></svg>;
}
function CheckIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>;
}
function CloseIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden><path d="M6 6l12 12M18 6L6 18" /></svg>;
}

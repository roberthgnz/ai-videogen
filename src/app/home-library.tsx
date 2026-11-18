"use client";

import { t as translate, localizedLabels } from "@/lib/i18n";
import { useEffect, useMemo, useState } from "react";
import { Dialog as D } from "radix-ui";
import { Button } from "@/components/ui/button";
import { shortTime } from "@/lib/editing/timeline";
import { listLibraryAction, type LibraryItem } from "./actions";
import "./home-references.css";

const KINDS = localizedLabels((translate) => ([["all", translate("Everything")], ["video", translate("Video")], ["image", translate("Image")], ["audio", "Audio"]] as const));
const SOURCES = [["all", "Cualquier origen"], ["upload", "Subidos"], ["generated", "Generados"], ["stock", "Stock"]] as const;
const KIND_LABEL: Record<LibraryItem["kind"], string> = localizedLabels((translate) => ({ video: translate("Video"), image: translate("Image"), audio: "Audio" }));
const SOURCE_LABEL: Record<LibraryItem["source"], string> = localizedLabels((translate) => ({ upload: "Subido", generated: translate("Generated"), stock: "Stock" }));

/** The composer key of a library file, so the same one is not added twice. */
export const libraryKey = (id: string) => `lib:${id}`;

/**
 * Picks files already in the library (uploaded, generated or stock) to edit in the new project, as if they
 * had been attached: nothing is uploaded again. `taken`: composer keys already there; `room`: how many more fit.
 */
export function LibraryPickerDialog({ open, onOpenChange, taken, room, onAdd }: { open: boolean; onOpenChange: (open: boolean) => void; taken: Set<string>; room: number; onAdd: (items: LibraryItem[]) => void }) {
  const [items, setItems] = useState<LibraryItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<(typeof KINDS)[number][0]>("all");
  const [source, setSource] = useState<(typeof SOURCES)[number][0]>("all");
  /** In the order they were picked: that is their order on the timeline. */
  const [picked, setPicked] = useState<string[]>([]);

  // Reload on every opening: uploads and renders may have landed since.
  useEffect(() => {
    if (!open) return;
    let live = true;
    listLibraryAction()
      .then((list) => { if (live) { setItems(list); setError(null); } })
      .catch(() => { if (live) setError(translate("You couldn't load your library.")); });
    return () => { live = false; };
  }, [open]);
  const close = (next: boolean) => { if (!next) { setPicked([]); setQuery(""); } onOpenChange(next); };

  const shown = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    return (items ?? []).filter((a) => (kind === "all" || a.kind === kind) && (source === "all" || a.source === source) && (!q || a.name.toLocaleLowerCase().includes(q)));
  }, [items, query, kind, source]);
  const full = picked.length >= room;

  return <D.Root open={open} onOpenChange={close}>
    <D.Portal>
      <D.Overlay className="ui-overlay fixed inset-0 z-50 bg-transparent" />
      <D.Content className="ui-pop ui-dialog home-ref-library fixed left-1/2 top-1/2 z-50 w-[min(720px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-[18px] p-6">
        <D.Title className="text-lg font-semibold tracking-tight">{translate("Your library")}</D.Title>
        <D.Description className="text-sm text-muted">{translate("Choose the videos, images or music you want to edit. You don't need to upload them again.")}</D.Description>
        <input className="home-ref-search" aria-label={translate("Search your library")} value={query} onChange={(e) => setQuery(e.target.value)} placeholder={translate("Search by name…")} />
        <div className="home-lib-filters">
          <div className="home-ref-roles" role="group" aria-label={translate("Type")}>
            {KINDS.map(([value, label]) => <button key={value} type="button" aria-pressed={kind === value} onClick={() => setKind(value)}>{label}</button>)}
          </div>
          <div className="home-ref-roles" role="group" aria-label={translate("Source")}>
            {SOURCES.map(([value, label]) => <button key={value} type="button" aria-pressed={source === value} onClick={() => setSource(value)}>{label}</button>)}
          </div>
        </div>
        <div className="home-ref-grid">
          {error ? <p className="home-ref-empty text-danger">{error}</p>
            : items === null ? <p className="home-ref-empty">{translate("Loading…")}</p>
            : shown.length === 0 ? <p className="home-ref-empty">{items.length ? translate("Nothing matches your search.") : translate("Your library is empty. What you raise or generate in your projects will appear here.")}</p>
            : shown.map((a) => {
              const key = libraryKey(a.id);
              const already = taken.has(key);
              const order = picked.indexOf(a.id);
              const on = order >= 0 || already;
              return <button key={a.id} type="button" className="home-ref-card" aria-pressed={on} disabled={already || (!on && full)} title={a.name}
                onClick={() => setPicked((p) => p.includes(a.id) ? p.filter((id) => id !== a.id) : [...p, a.id])}>
                <span className="home-ref-card-thumb">
                  {/* eslint-disable-next-line @next/next/no-img-element -- library thumbnail */}
                  {a.thumbnail ? <img src={a.thumbnail} alt="" loading="lazy" /> : <MusicIcon />}
                  {a.kind !== "image" && a.duration > 0 && <span className="home-lib-duration">{shortTime(a.duration)}</span>}
                  {on && <span className="home-ref-card-check">{order >= 0 ? <b>{order + 1}</b> : <CheckIcon />}</span>}
                </span>
                <strong>{a.name}</strong>
                <small>{KIND_LABEL[a.kind]} · {SOURCE_LABEL[a.source]}</small>
              </button>;
            })}
        </div>
        <div className="flex items-center justify-end gap-2 pt-1">
          {full && room > 0 && <p className="mr-auto text-xs text-muted">{translate("Room for")} {room}{translate("file")}{room === 1 ? "" : "s"}{translate("More.")}</p>}
          <D.Close asChild><Button variant="ghost">{translate("Cancel")}</Button></D.Close>
          <Button variant="primary" disabled={!picked.length} onClick={() => {
            const byId = new Map((items ?? []).map((a) => [a.id, a]));
            onAdd(picked.flatMap((id) => byId.get(id) ?? []));
            close(false);
          }}>{picked.length ? translate("Add {0}", picked.length) : translate("Add")}</Button>
        </div>
      </D.Content>
    </D.Portal>
  </D.Root>;
}

export function LibraryIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><rect x="3.5" y="4" width="7" height="7" rx="1.5" /><rect x="13.5" y="4" width="7" height="7" rx="1.5" /><rect x="3.5" y="14" width="7" height="7" rx="1.5" /><rect x="13.5" y="14" width="7" height="7" rx="1.5" /></svg>;
}
function MusicIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M9 18V5l11-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="17" cy="16" r="3" /></svg>;
}
function CheckIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>;
}

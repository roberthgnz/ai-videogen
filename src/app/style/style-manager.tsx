"use client";

import { t as translate } from "@/lib/i18n";
import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/alert-dialog";
import { EditorIcon } from "../projects/[id]/desktop-controls";
import { profileSummary, type StyleProfile } from "@/lib/style-profile/schema";
import { createStyleProfileAction, deleteStyleProfileAction, duplicateStyleProfileAction, saveStyleProfileAction } from "./actions";
import { ProfileEditor } from "./profile-editor";

type Usage = Record<string, { id: string; title: string }[]>;
type Notice = { ok: boolean; text: string } | null;

/** Colour dots of a profile, to tell profiles apart at a glance. */
export function ColorDots({ profile }: { profile: StyleProfile }) {
  if (!profile.colors.length) return null;
  return <i aria-hidden>{profile.colors.slice(0, 6).map((c, n) => <em key={n} style={{ background: c.hex }} />)}</i>;
}

/**
 * Every «Mi estilo» profile: the list on the left, the open one on the right, saved in one go with the bar
 * that appears when something changed (as in Ajustes). Projects choose their profile in Referencias.
 */
export function StyleManager({ initialProfiles, usage, initialId }: { initialProfiles: StyleProfile[]; usage: Usage; initialId: string | null }) {
  const [profiles, setProfiles] = useState(initialProfiles);
  const [selectedId, setSelectedId] = useState<string | null>(initialProfiles.find((p) => p.id === initialId)?.id ?? initialProfiles[0]?.id ?? null);
  const selected = profiles.find((p) => p.id === selectedId) ?? null;
  const [draft, setDraft] = useState<StyleProfile | null>(selected);
  const [notice, setNotice] = useState<Notice>(null);
  const [pending, start] = useTransition();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [switchTo, setSwitchTo] = useState<string | null>(null);
  const dirty = !!draft && !!selected && JSON.stringify(draft) !== JSON.stringify(selected);

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  function open(id: string, list = profiles) {
    setSelectedId(id);
    setDraft(list.find((p) => p.id === id) ?? null);
    setNotice(null);
    // The address names the open profile, so «Editar» from a project lands on it and a reload keeps it.
    try { window.history.replaceState(null, "", `/style?perfil=${encodeURIComponent(id)}`); } catch { /* not important */ }
  }
  function choose(id: string) {
    if (id === selectedId) return;
    if (dirty) setSwitchTo(id); else open(id);
  }
  function put(profile: StyleProfile) {
    const next = profiles.some((p) => p.id === profile.id) ? profiles.map((p) => (p.id === profile.id ? profile : p)) : [profile, ...profiles];
    setProfiles(next);
    return next;
  }
  function create() {
    start(async () => {
      const result = await createStyleProfileAction().catch(() => ({ ok: false as const, error: translate("You couldn't create the style.") }));
      if (!result.ok) { setNotice({ ok: false, text: result.error }); return; }
      open(result.profile.id, put(result.profile));
      setNotice({ ok: true, text: translate("Style created. Fill only what matters to you: what you leave empty is decided by each video.") });
    });
  }
  function save() {
    if (!draft) return;
    start(async () => {
      const result = await saveStyleProfileAction(draft).catch(() => ({ ok: false as const, error: translate("You couldn't keep the style.") }));
      if (!result.ok) { setNotice({ ok: false, text: result.error }); return; }
      put(result.profile);
      setDraft(result.profile);
      setNotice({ ok: true, text: translate("\"{0}\" saved. The assistant will use it from the next message in projects that have it.", result.profile.name) });
    });
  }
  function duplicate() {
    if (!selected) return;
    start(async () => {
      const result = await duplicateStyleProfileAction(selected.id).catch(() => ({ ok: false as const, error: translate("You couldn't double the style.") }));
      if (!result.ok) { setNotice({ ok: false, text: result.error }); return; }
      open(result.profile.id, put(result.profile));
      setNotice({ ok: true, text: translate("Copy created: \"{0}.\" Change the name and whatever you want.", result.profile.name) });
    });
  }
  function remove() {
    if (!selected) return;
    start(async () => {
      const result = await deleteStyleProfileAction(selected.id).catch(() => ({ ok: false as const, error: translate("You couldn't erase the style.") }));
      setConfirmDelete(false);
      if (!result.ok) { setNotice({ ok: false, text: result.error }); return; }
      const next = profiles.filter((p) => p.id !== selected.id);
      setProfiles(next);
      if (next[0]) open(next[0].id, next); else { setSelectedId(null); setDraft(null); }
      setNotice({ ok: true, text: `«${selected.name}» borrado.` });
    });
  }

  const users = selected ? usage[selected.id] ?? [] : [];
  return (
    <main className="style-page">
      <nav className="style-list" aria-label={translate("Your styles")}>
        <h1>{translate("My style")}</h1>
        <p>{translate("What you want in all your videos. The wizard applies it when editing on every project that uses it.")}</p>
        {profiles.length > 0 && <ul>
          {profiles.map((p) => <li key={p.id}><button type="button" aria-current={p.id === selectedId} onClick={() => choose(p.id)}>
            <strong>{p.id === selectedId && draft ? draft.name || translate("No name") : p.name}</strong>
            <span>{profileSummary(p)}</span>
            <span>{usage[p.id]?.length ? `Lo usan ${usage[p.id].length} ${usage[p.id].length === 1 ? "proyecto" : "proyectos"}` : translate("No project yet uses it")}</span>
            <ColorDots profile={p} />
          </button></li>)}
        </ul>}
        {profiles.length > 0 && <Button variant="outline" size="sm" disabled={pending} onClick={create}><EditorIcon name="plus" />{translate("New style")}</Button>}
      </nav>

      <div className="style-main">
        {notice && <p className="style-notice" data-error={notice.ok ? undefined : ""} role={notice.ok ? "status" : "alert"}>{notice.text}</p>}
        {!draft ? <section className="style-empty">
          <h2>{translate("Create your style once and use it on all your videos.")}</h2>
          <p>{translate("Colors, fountains, logos, mounting rhythm, how the subtitles and your rules go (\"without emojis,\" \"never cover my face\"). The assistant follows him without having to repeat him.")}</p>
          <ol>
            <li>{translate("Create a style here, or from a project with references: References › My style › \"Create from these references.\"")}</li>
            <li>{translate("In each project, choose which style you use (in References).")}</li>
            <li>{translate("When you correct something in the chat, the assistant will propose to keep it as a rule.")}</li>
          </ol>
          <Button variant="primary" disabled={pending} onClick={create}><EditorIcon name="plus" />{translate("Create my first style")}</Button>
        </section> : <>
          <div className="style-main-head">
            <div>
              <h2>{draft.name || translate("No name")}</h2>
              <p>{users.length ? <>{translate("Used by:")} {users.map((u, i) => <span key={u.id}>{i > 0 && ", "}<Link href={`/projects/${u.id}`} className="text-tint">{u.title}</Link></span>)}.</> : translate("No project yet uses it. Choose it in a project from References › My style.")}</p>
            </div>
            <div className="style-actions">
              <Button size="sm" variant="ghost" disabled={pending || dirty} title={dirty ? "Guarda o descarta los cambios antes" : undefined} onClick={duplicate}><EditorIcon name="duplicate" />{translate("Double")}</Button>
              <Button size="sm" variant="ghost" disabled={pending} onClick={() => setConfirmDelete(true)}><EditorIcon name="trash" />{translate("Delete")}</Button>
            </div>
          </div>
          <ProfileEditor value={draft} onChange={(next) => { setDraft(next); setNotice(null); }} disabled={pending} />
        </>}
      </div>

      <div className="style-savebar" data-visible={dirty || undefined} role="region" aria-label={translate("Unsaved changes")}>
        <span>{translate("You have unsaved changes")}</span>
        <Button size="sm" variant="glass" disabled={pending || !dirty} onClick={() => { setDraft(selected); setNotice(null); }}>{translate("Discard")}</Button>
        <Button size="sm" variant="primary" disabled={pending || !dirty} onClick={save}>{pending ? translate("Saving…") : translate("Save Style")}</Button>
      </div>

      <ConfirmDialog open={confirmDelete} onOpenChange={setConfirmDelete} pending={pending}
        title={translate("Delete \"{0}\"?", selected?.name ?? "")}
        description={users.length ? translate("They use it {0} {1}: they will run out of style. Their videos do not change.", users.length, users.length === 1 ? "proyecto" : "proyectos") : translate("No project uses it.")}
        confirmLabel="Borrar estilo" onConfirm={remove} />
      <ConfirmDialog open={!!switchTo} onOpenChange={(o) => { if (!o) setSwitchTo(null); }}
        title={translate("Unload the changes?")} description={translate("You have unsaved changes in \"{0}.\" If you change style, they are lost.", selected?.name ?? "")}
        confirmLabel="Descartar y cambiar" onConfirm={() => { const id = switchTo; setSwitchTo(null); if (id) open(id); }} />
    </main>
  );
}

"use client";

import { t as translate } from "@/lib/i18n";
import { useEffect, useState, useTransition } from "react";
import { Dialog } from "radix-ui";
import { Button } from "@/components/ui/button";
import { Select, SelectItem, SelectSeparator } from "@/components/ui/select";
import { blankProfile, profileSummary, type StyleProfile } from "@/lib/style-profile/schema";
import { assignStyleProfileAction, draftStyleFromReferencesAction, projectStyleAction, saveStyleProfileAction } from "@/app/style/actions";
import { ProfileEditor } from "@/app/style/profile-editor";
import { ColorDots } from "@/app/style/style-manager";
import { EditorIcon } from "./desktop-controls";
import "@/app/style/style.css";

const NONE = "__none";
const NEW = "__new";

/** What the review dialog is for: editing the project's profile, or saving a proposal made from the references. */
type Review = { profile: StyleProfile; mode: "edit" | "update" | "new"; studied?: string[] };

/**
 * «Mi estilo» inside Referencias: which profile this project uses, a summary of it, and the two ways to fill it
 * from here: edit it, or build it from what the assistant observed in this project's references. Nothing is
 * saved until the user presses save in the review.
 */
export function StyleProfileCard({ projectId, disabled, hasReferences, onUse }: { projectId: string; disabled: boolean; hasReferences: boolean; onUse: (message: string) => void }) {
  const [profiles, setProfiles] = useState<StyleProfile[] | null>(null);
  const [assignedId, setAssignedId] = useState<string | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [unstudied, setUnstudied] = useState<string[] | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    let live = true;
    projectStyleAction(projectId).then((s) => { if (live) { setProfiles(s.profiles); setAssignedId(s.assignedId); } }).catch(() => { if (live) setProfiles([]); });
    return () => { live = false; };
  }, [projectId]);

  const assigned = profiles?.find((p) => p.id === assignedId) ?? null;
  const busy = disabled || pending || profiles === null;
  const put = (profile: StyleProfile) => setProfiles((list) => (list?.some((p) => p.id === profile.id) ? list.map((p) => (p.id === profile.id ? profile : p)) : [profile, ...(list ?? [])]));

  function choose(value: string) {
    setNotice(null);
    setUnstudied(null);
    // A new profile is only a draft until the user saves it in the review.
    if (value === NEW) { setReview({ profile: blankProfile(crypto.randomUUID(), translate("My style"), Date.now()), mode: "new" }); return; }
    start(async () => {
      const profileId = value === NONE ? null : value;
      const result = await assignStyleProfileAction(projectId, profileId).catch(() => ({ ok: false as const, error: translate("You couldn't change the style.") }));
      if (!result.ok) { setNotice({ ok: false, text: result.error }); return; }
      setAssignedId(profileId);
      const name = profiles?.find((p) => p.id === profileId)?.name;
      setNotice({ ok: true, text: profileId ? translate("This project now uses \"{0}.\" The assistant will apply it from your next message.", name) : translate("This project no longer uses any style.") });
    });
  }

  function fromReferences(intoCurrent: boolean) {
    setNotice(null);
    setUnstudied(null);
    start(async () => {
      const draft = await draftStyleFromReferencesAction(projectId, intoCurrent).catch(() => ({ ok: false as const, error: translate("The proposal could not be prepared."), unstudied: [] as string[] }));
      if (!draft.ok) { setNotice({ ok: false, text: draft.error }); setUnstudied(draft.unstudied.length ? draft.unstudied : null); return; }
      setReview({ profile: draft.profile, mode: draft.base ? "update" : "new", studied: draft.studied });
    });
  }

  function saved(profile: StyleProfile, text: string) {
    put(profile);
    setAssignedId(profile.id);
    setReview(null);
    setNotice({ ok: true, text });
  }

  const studyPrompt = (titles: string[]) => translate("Study my references {0} and save your analysis (rhythm, texts, appearance and audio) with save_reference_analysis. Do not change the assembly.", titles.map((t) => `«${t}»`).join(", "));

  return <section className="style-studio-card" aria-label={translate("My style")}>
    <header>
      <EditorIcon name="sparkles" />
      <strong>{translate("My style")}</strong>
      <a href={assigned ? `/style?perfil=${encodeURIComponent(assigned.id)}` : "/style"} target="_blank" rel="noreferrer">{translate("All my styles ↗")}</a>
    </header>
    <p>{translate("Your colors, sources, logos, rhythm, subtitles and rules for all your videos. The assistant follows the style you choose here.")}</p>
    {profiles === null ? <p role="status">{translate("Loading your styles…")}</p> : <Select aria-label={translate("Style of this project")} value={assignedId ?? NONE} disabled={busy} onValueChange={choose}
      leading={assigned?.colors[0] ? <span aria-hidden className="h-2.5 w-2.5 flex-none rounded-full" style={{ background: assigned.colors[0].hex }} /> : undefined}>
      <SelectItem value={NONE} hint={translate("The assistant decides with your request and your references")}>{translate("No style")}</SelectItem>
      {profiles.map((p) => <SelectItem key={p.id} value={p.id} hint={profileSummary(p)}>{p.name}</SelectItem>)}
      <SelectSeparator />
      <SelectItem value={NEW} hint={translate("Start blank and fill in what you care about")}>{translate("Create a new style…")}</SelectItem>
    </Select>}
    {assigned && <div className="style-studio-summary"><ColorDots profile={assigned} /><span>{profileSummary(assigned)}</span></div>}

    <div className="style-actions">
      {assigned && <Button size="sm" variant="outline" disabled={busy} onClick={() => { setNotice(null); setReview({ profile: assigned, mode: "edit" }); }}>{translate("Edit \"")}{assigned.name}»</Button>}
      {hasReferences && (assigned
        ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => fromReferences(true)}><EditorIcon name="brand" />{translate("Complete with my references")}</Button>
        : <Button size="sm" variant="outline" disabled={busy} onClick={() => fromReferences(false)}><EditorIcon name="brand" />{translate("Create from my references")}</Button>)}
      {assigned && hasReferences && <Button size="sm" variant="ghost" disabled={busy} onClick={() => fromReferences(false)}>{translate("Create a new one with them")}</Button>}
    </div>
    {!hasReferences && !assigned && <p>{translate("Do you have a video with the style you like? Put it up as a reference and create your style from it.")}</p>}
    {pending && <p role="status">{translate("One moment…")}</p>}
    {notice && <p className={notice.ok ? undefined : "style-error"} role={notice.ok ? "status" : "alert"}>{notice.text}</p>}
    {unstudied && <div className="style-actions">
      <Button size="sm" variant="primary" disabled={disabled} onClick={() => { onUse(studyPrompt(unstudied)); setUnstudied(null); setNotice({ ok: true, text: translate("I left the request in the chat: send it. When the assistant is finished, press again \"Create from my references.\"") }); }}>
        <EditorIcon name="sparkles" />{translate("Ask the assistant to study them")}</Button>
    </div>}

    {review && <StyleReviewDialog projectId={projectId} review={review} assignedName={assigned?.name ?? null} onClose={() => setReview(null)} onSaved={saved} />}
  </section>;
}

function StyleReviewDialog({ projectId, review, assignedName, onClose, onSaved }: { projectId: string; review: Review; assignedName: string | null; onClose: () => void; onSaved: (profile: StyleProfile, text: string) => void }) {
  const [draft, setDraft] = useState(review.profile);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const fromReferences = !!review.studied;
  const title = review.mode === "edit" ? translate("Edit \"{0}\"", review.profile.name) : review.mode === "update" ? translate("Complete \"{0}\" with your references", assignedName ?? review.profile.name) : fromReferences ? translate("Your style, from your references") : translate("New style");
  const description = fromReferences
    ? translate("This is what the assistant observed in {0}. Check it and change what does not fit: it is not saved until you press the button.", review.studied!.map((t) => `«${t}»`).join(", "))
    : review.mode === "edit" ? translate("The changes are valid for all projects that use this style.") : translate("Fill in only what matters to you: what you leave empty is decided by each video.");
  const action = review.mode === "edit" ? translate("Save changes") : review.mode === "update" ? translate("Update the style") : translate("Save and use in this project");

  function save() {
    setError(null);
    start(async () => {
      const result = await saveStyleProfileAction(draft, projectId).catch(() => ({ ok: false as const, error: translate("You couldn't keep the style.") }));
      if (!result.ok) { setError(result.error); return; }
      onSaved(result.profile, review.mode === "edit"
        ? translate("\"{0}\" saved. It's for all the projects that use it.", result.profile.name)
        : translate("\"{0}\" saved and in use in this project. The assistant will apply it from your next message; try to ask \"Apply my style to assembly.\"", result.profile.name));
    });
  }

  return <Dialog.Root open onOpenChange={(open) => { if (!open && !pending) onClose(); }}>
    <Dialog.Portal>
      <Dialog.Overlay className="ui-overlay style-overlay" />
      <Dialog.Content className="ui-pop ui-dialog style-dialog">
        <header>
          <div><Dialog.Title asChild><h2>{title}</h2></Dialog.Title><Dialog.Description asChild><p>{description}</p></Dialog.Description></div>
          <Dialog.Close asChild><Button size="icon-sm" aria-label={translate("Close without saving")} disabled={pending}><EditorIcon name="close" /></Button></Dialog.Close>
        </header>
        <div className="style-dialog-body"><ProfileEditor value={draft} onChange={setDraft} disabled={pending} /></div>
        <footer>
          {error && <p className="style-error" role="alert">{error}</p>}
          <Button onClick={onClose} disabled={pending}>{translate("Cancel")}</Button>
          <Button variant="primary" onClick={save} disabled={pending}>{pending ? translate("Saving…") : action}</Button>
        </footer>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}

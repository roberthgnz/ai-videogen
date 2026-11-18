"use client";

import { t as translate, getLocale } from "@/lib/i18n";
import { useEffect, useState, useTransition } from "react";
import { ConfirmDialog } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/field";
import {
  nextPass,
  PASS_INFO,
  PASS_MODE_INFO,
  PASS_MODES,
  PASS_STATUS_LABELS,
  passList,
  VERSION_KIND_LABELS,
  type EditPass,
  type PassesView,
  type PassMode,
  type VersionView,
} from "@/lib/editing/passes-shared";
import type { EditDocument } from "@/lib/editing/schema";
import { EditorIcon } from "./desktop-controls";
import { sendAgentMessageAction } from "./agent-actions";
import { approvePassAction, deleteVersionAction, renameVersionAction, restoreVersionAction, saveVersionAction, setPassIncludedAction, setPassModeAction } from "./pass-actions";
import "./passes.css";

/**
 * Editing in passes, in two pieces that never compete for the eye. Above the chat, one quiet line: where
 * the project is (PassesStrip), with the review mode and the saved versions behind a menu. Right above the
 * message box, the one thing the project needs from the user now and the button that answers it (PassesNow).
 * The agent does the passes (agent-skills/passes); approving is always the user's. Every pass is optional:
 * the agent picks the ones this video needs from the request (or asks), and the user can add or drop one.
 */

interface Props {
  projectId: string;
  passes: PassesView;
  /** The project has a montage to edit: the passes show even before the first one. */
  hasMontage: boolean;
  /** The agent is working: it shows what on, and nothing can be pressed. */
  busy: boolean;
  /** The studio is busy with something else (an import, a save). */
  disabled: boolean;
  /** Saves the studio's pending edits; false when that failed (the studio says why). */
  flush: () => Promise<boolean>;
  /** A version was restored: the studio takes its montage. */
  onRestored: (edit: EditDocument) => void;
}

const lower = (pass: EditPass) => PASS_INFO[pass].label.toLowerCase();
const when = (iso: string) => new Date(iso).toLocaleString(getLocale(), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/** The passes have something to show: the project has a montage, or a pass or a version already exists. */
export const passesShown = (view: PassesView, hasMontage: boolean) => view.started || hasMontage;

/**
 * Runs what the user pressed: it saves what is on screen first, so approvals and versions hold exactly what
 * they see, and says how it went. What went well fades after a while; what failed stays until the next try.
 */
function useAct(flush: () => Promise<boolean>) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 9000);
    return () => clearTimeout(timer);
  }, [notice]);
  function act(run: () => Promise<string | null>) {
    setError(null); setNotice(null);
    start(async () => {
      try {
        if (!(await flush())) { setError(translate("They couldn't keep your last changes.")); return; }
        const message = await run();
        if (message) setNotice(message);
      } catch (e) { setError(e instanceof Error ? e.message : translate("It couldn't be completed.")); }
    });
  }
  return { pending, start, error, setError, notice, setNotice, act };
}

/** Goes back to a saved version; what was on screen is kept as a copy first. Returns what to tell the user. */
async function restoreVersion(projectId: string, version: VersionView, onRestored: (edit: EditDocument) => void) {
  const result = await restoreVersionAction(projectId, version.id);
  if (!result.ok) throw new Error(result.error);
  onRestored(result.edit);
  return `Has vuelto a «${result.name}».${result.backup ? translate(" What you had is kept as \"{0}.\"", result.backup) : ""}${result.dropped ? ` ${result.dropped === 1 ? translate("A clip used a file that is no longer in the project and has been left out.") : translate("{0} clips used files that are no longer in the project and have been left out.", result.dropped)}` : ""}`;
}

/**
 * Where the project is, in one line above the chat: the passes this video needs, each with its state. Which
 * ones those are, the review mode and the saved versions are a menu away: they matter now and then, not on
 * every look at the panel.
 */
export function PassesStrip(p: Props) {
  const view = p.passes;
  const { pending, start, error, setError, notice, setNotice, act } = useAct(p.flush);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [name, setName] = useState("");
  /** The version whose name is being edited, and the name as typed. */
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  /** The version the user asked to delete: the dialog asks first. */
  const [deleting, setDeleting] = useState<VersionView | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  if (!passesShown(view, p.hasMontage)) return null;

  const blocked = p.disabled || p.busy || pending;
  function chooseMode(mode: PassMode) {
    if (mode === view.mode) return;
    act(async () => {
      const result = await setPassModeAction(p.projectId, mode);
      if (!result.ok) throw new Error(result.error);
      return `Modo ${PASS_MODE_INFO[mode].label.toLowerCase()}: ${PASS_MODE_INFO[mode].hint}`;
    });
  }
  function togglePass(pass: EditPass, include: boolean) {
    act(async () => {
      const result = await setPassIncludedAction(p.projectId, pass, include);
      if (!result.ok) throw new Error(result.error);
      return include ? translate("{0} back to the steps of this video.", PASS_INFO[pass].label) : translate("{0} is out: this video doesn't need it.", PASS_INFO[pass].label);
    });
  }
  function saveNamed(e: React.FormEvent) {
    e.preventDefault();
    const title = name.trim();
    if (!title) { setError(translate("Name the version, for example \"TikTok Short Version.\"")); return; }
    act(async () => {
      const result = await saveVersionAction(p.projectId, title);
      if (!result.ok) throw new Error(result.error);
      setName("");
      return translate("Version \"{0}\" saved. You can return to it whenever you want.", result.name);
    });
  }
  function saveRename(e: React.FormEvent) {
    e.preventDefault();
    const target = renaming;
    if (!target) return;
    if (!target.name.trim()) { setError(translate("Put a name on the version.")); return; }
    act(async () => {
      const result = await renameVersionAction(p.projectId, target.id, target.name);
      if (!result.ok) throw new Error(result.error);
      setRenaming(null);
      return translate("Name changed: \"{0}.\"", result.name);
    });
  }
  function confirmDelete() {
    const target = deleting;
    if (!target) return;
    setDeleteError(null);
    start(async () => {
      const result = await deleteVersionAction(p.projectId, target.id).catch(() => ({ ok: false as const, error: translate("The version could not be deleted.") }));
      if (!result.ok) { setDeleteError(result.error); return; }
      setDeleting(null); setError(null);
      setNotice(translate("Version \"{0}\" deleted.", result.name));
    });
  }

  const plan = view.passes.filter((x) => x.status !== "skipped");
  return <section className="passes-strip" aria-label={translate("Editing passes")}>
    <div className="passes-strip-row">
      {!view.planned
        ? <p className="passes-steps-empty" title={translate("The agent chooses the steps as you ask him; if he is not clear, he asks you.")}>{translate("Editing steps follow your request")}</p>
        : !plan.length
          ? <p className="passes-steps-empty">{translate("No editing steps")}</p>
          : <ol className="passes-steps">
            {plan.map((x) => <li key={x.pass} data-status={x.status} aria-current={x.pass === view.current ? "step" : undefined} title={`${PASS_INFO[x.pass].label}: ${PASS_STATUS_LABELS[x.status].toLowerCase()}`}>
              <i aria-hidden>{x.status === "approved" ? <EditorIcon name="check" /> : x.status === "working" && p.busy ? <span className="pro-spinner" /> : null}</i>
              <span>{PASS_INFO[x.pass].label}</span>
              <span className="sr-only">: {PASS_STATUS_LABELS[x.status].toLowerCase()}</span>
            </li>)}
          </ol>}
      <Menu><MenuTrigger asChild><Button size="icon-sm" variant="ghost" className="passes-more" aria-label={translate("Steps of this video, saved versions and review mode")} title={translate("Steps, versions and review mode")}>•••</Button></MenuTrigger><MenuContent className="passes-menu">
        <MenuItem icon={<EditorIcon name="save" />} onSelect={() => { setError(null); setVersionsOpen(true); }}>
          <span>{translate("Versions saved")}{view.versions.length > 0 && <small> · {view.versions.length}</small>}</span>
        </MenuItem>
        <MenuSeparator />
        <p className="passes-menu-label" role="presentation">{translate("Steps of this video")}</p>
        {view.passes.map((x) => {
          const on = x.status !== "skipped";
          // The menu stays open, so several steps can be switched in a row.
          return <MenuItem key={x.pass} role="menuitemcheckbox" aria-checked={on} disabled={blocked} icon={on ? <EditorIcon name="check" /> : <i aria-hidden />} onSelect={(e) => { e.preventDefault(); togglePass(x.pass, !on); }}>
            <span className="passes-menu-mode"><strong>{PASS_INFO[x.pass].label}</strong><small>{on ? PASS_INFO[x.pass].covers : x.note || translate("This video doesn't need it.")}</small></span>
          </MenuItem>;
        })}
        <MenuSeparator />
        {PASS_MODES.map((mode) => <MenuItem key={mode} disabled={blocked} icon={view.mode === mode ? <EditorIcon name="check" /> : <i aria-hidden />} onSelect={() => chooseMode(mode)}>
          <span className="passes-menu-mode"><strong>{translate("Mode")} {PASS_MODE_INFO[mode].label.toLowerCase()}</strong><small>{PASS_MODE_INFO[mode].hint}</small></span>
        </MenuItem>)}
      </MenuContent></Menu>
    </div>
    {error && <p className="passes-error" role="alert">{error}</p>}
    {notice && <p className="passes-notice" role="status">{notice}</p>}
    {versionsOpen && <div className="passes-versions">
      <header><strong>{translate("Versions saved")}</strong><Button size="icon-sm" variant="ghost" aria-label={translate("Close the versions")} onClick={() => { setVersionsOpen(false); setRenaming(null); }}><EditorIcon name="close" /></Button></header>
      <form onSubmit={saveNamed}>
        <Input aria-label={translate("Name of version")} placeholder={translate("Ej.: Short version for TikTok")} value={name} maxLength={80} disabled={blocked} onValueChange={setName} />
        <Button size="sm" variant="outline" type="submit" disabled={blocked}>{translate("Save")}</Button>
      </form>
      <p className="passes-hint">{translate("Save how the assembly is now. Return to one version does not delete the others: whatever you have is saved before.")}</p>
      {view.versions.length === 0
        ? <p className="passes-empty">{translate("There are still no versions. They are saved alone when passing each pass.")}</p>
        : <ul>{view.versions.map((v) => <li key={v.id} data-kind={v.kind}>
          {renaming?.id === v.id
            ? <form onSubmit={saveRename} className="passes-rename">
              <Input aria-label={translate("New name for \"{0}\"", v.name)} value={renaming.name} maxLength={80} disabled={blocked} autoFocus
                onValueChange={(name) => setRenaming({ id: v.id, name })} onKeyDown={(e) => { if (e.key === "Escape") setRenaming(null); }} />
              <Button size="sm" variant="primary" type="submit" disabled={blocked}>{translate("Save")}</Button>
              <Button size="sm" variant="ghost" type="button" onClick={() => setRenaming(null)}>{translate("Cancel")}</Button>
            </form>
            : <>
              <div>
                <strong>{v.name}</strong>
                <small><span>{VERSION_KIND_LABELS[v.kind]}</span> · <time dateTime={v.createdAt} suppressHydrationWarning>{when(v.createdAt)}</time> · {v.summary}</small>
              </div>
              {v.current
                ? <span className="passes-current">{translate("Current version")}</span>
                : <Button size="sm" variant="outline" disabled={blocked} onClick={() => act(() => restoreVersion(p.projectId, v, p.onRestored))}>{translate("Restore this version")}</Button>}
              <Menu><MenuTrigger asChild><Button size="icon-sm" variant="ghost" disabled={blocked} aria-label={translate("More options for \"{0}\"", v.name)}>•••</Button></MenuTrigger><MenuContent>
                <MenuItem icon={<EditorIcon name="text" />} onSelect={() => { setError(null); setNotice(null); setRenaming({ id: v.id, name: v.name }); }}>{translate("Change the name")}</MenuItem>
                <MenuItem destructive icon={<EditorIcon name="trash" />} onSelect={() => { setDeleteError(null); setDeleting(v); }}>{translate("Delete")}</MenuItem>
              </MenuContent></Menu>
            </>}
        </li>)}</ul>}
    </div>}
    <ConfirmDialog open={!!deleting} onOpenChange={(open) => { if (!open) { setDeleting(null); setDeleteError(null); } }}
      title={translate("Delete \"{0}\"?", deleting?.name ?? "")}
      description={translate("It is erased forever and cannot be recovered. The assembly you have now does not change {0}.", deleting?.kind === "approved" ? translate(" and the past is still approved") : "")}
      confirmLabel="Borrar" pending={pending} error={deleteError} onConfirm={confirmDelete} />
  </section>;
}

/**
 * The next step, right above the message box: what the project needs from the user now in one sentence, and
 * the buttons that answer it — never more than one filled. While the agent works there is nothing to decide,
 * so it steps aside: the chat shows what the agent is doing.
 */
export function PassesNow(p: Props & {
  /** Leaves a request in the chat box, ready for the user to finish and send. */
  onAsk: (text: string) => void;
  /** Opens the export dialog, as the toolbar's «Exportar» does. */
  onExport: () => void;
}) {
  const view = p.passes;
  const { pending, error, setError, notice, setNotice, act } = useAct(p.flush);
  /** The pass the user is writing changes for: the card shows what to write. */
  const [asking, setAsking] = useState<EditPass | "start" | null>(null);
  if (!passesShown(view, p.hasMontage) || p.busy) return null;

  const blocked = p.disabled || pending;
  const entry = (pass: EditPass) => view.passes.find((x) => x.pass === pass)!;
  const current = view.current ? entry(view.current) : null;
  const working = view.passes.find((x) => x.status === "working");
  const reviews = view.passes.filter((x) => x.status === "review");
  const lastApprovedVersion = view.lastApproved ? view.versions.find((v) => v.id === entry(view.lastApproved!).versionId) : undefined;
  const plan = view.passes.filter((x) => x.status !== "skipped").map((x) => x.pass);
  const skipped = (pass: EditPass) => !plan.includes(pass);
  /** The next pass of the plan still to approve after `pass` (a reopened pass can have approved ones after it). */
  const followingOf = (pass: EditPass) => view.passes.slice(view.passes.findIndex((x) => x.pass === pass) + 1).find((x) => x.status !== "approved" && x.status !== "skipped") ?? null;

  async function send(text: string) {
    const result = await sendAgentMessageAction(p.projectId, text, translate("Editable assembly · edition by past"));
    if (!result.ok) throw new Error(result.error);
  }
  /**
   * With `follow` the agent goes on with the next pass. The approval lands in the chat as a reply that says
   * what was saved and carries its own «Deshacer»: the card only moves on to the next step, it does not repeat it.
   */
  function approve(upTo: EditPass, follow: boolean) {
    act(async () => {
      const result = await approvePassAction(p.projectId, upTo, follow);
      if (!result.ok) throw new Error(result.error);
      setAsking(null);
      if (result.warning) throw new Error(result.warning);
      return null;
    });
  }
  function proceed(text: string) {
    setAsking(null);
    act(async () => { await send(text); return null; });
  }
  function ask(pass: EditPass | "start", text: string) {
    setAsking(pass); setError(null); setNotice(null);
    p.onAsk(text);
  }

  // What the project needs from the user now, in one sentence, and the buttons that answer it.
  let title: string;
  let body: string;
  let notes: { pass: EditPass; note: string }[] = [];
  let actions: React.ReactNode;
  if (!view.planned) {
    // Which steps this video needs comes from what the user asks for: it may come already cut, with its captions or its music.
    title = translate("What would you like to change?");
    body = translate("Describe the edit you want. The assistant will choose the relevant steps for cuts, subtitles, graphics, and sound.");
    actions = <Button size="sm" variant="primary" disabled={blocked} onClick={() => ask("start", translate("Edit this video. I want "))}>{translate("Ask for edits")}</Button>;
  } else if (!current) {
    title = translate("Video ready to export.");
    body = plan.length ? translate("If you still want to change something, ask the agent down here.") : translate("This video doesn't need editing steps. If you want to change something, ask the agent down here.");
    actions = <Button size="sm" variant="primary" disabled={blocked} onClick={p.onExport}>{translate("Export…")}</Button>;
  } else if (working) {
    title = `${PASS_INFO[working.pass].label} a medias.`;
    body = translate("The agent stopped or asked you something, answer him down here or tell him to keep going.");
    actions = <>
      <Button size="sm" variant="primary" disabled={blocked} onClick={() => proceed(translate("It's still with the past of {0} where you left it.", lower(working.pass)))}>{translate("Continue with")} {PASS_INFO[working.pass].the}</Button>
      {lastApprovedVersion && <Button size="sm" variant="ghost" disabled={blocked} onClick={() => act(() => restoreVersion(p.projectId, lastApprovedVersion, p.onRestored))}>{translate("Restore “")}{lastApprovedVersion.name}»</Button>}
    </>;
  } else if (view.mode === "fast" && reviews.length) {
    const last = reviews.at(-1)!.pass;
    const all = !nextPass(last, skipped);
    title = all ? translate("All set to check.") : translate("{0} to check.", reviews.length === 1 ? PASS_INFO[last].ready : translate("{0} past lists", reviews.length));
    body = translate("If you like it, try it; if not, say what to change.");
    notes = reviews.filter((x) => x.note).map((x) => ({ pass: x.pass, note: x.note }));
    actions = <>
      <Button size="sm" variant="primary" disabled={blocked} onClick={() => approve(last, !all)}>{all ? translate("Approve all") : "Aprobar y seguir"}</Button>
      <Button size="sm" variant="ghost" disabled={blocked} onClick={() => ask(reviews[0].pass, translate("Change in {0}: ", PASS_INFO[reviews[0].pass].the))}>{translate("Request changes")}</Button>
    </>;
  } else if (current.status === "review") {
    // A pass waiting for review after it is reviewed next, not worked on again.
    const following = followingOf(current.pass);
    const goOn = following && following.status !== "review" ? following.pass : null;
    title = translate("{0} to check.", PASS_INFO[current.pass].ready);
    body = translate("Reprove it and see {0}.", PASS_INFO[current.pass].covers);
    notes = current.note ? [{ pass: current.pass, note: current.note }] : [];
    actions = <>
      <Button size="sm" variant="primary" disabled={blocked} onClick={() => approve(current.pass, !!goOn)}>{goOn ? `Aprobar y seguir con ${PASS_INFO[goOn].the}` : "Aprobar"}</Button>
      <Button size="sm" variant="ghost" disabled={blocked} onClick={() => ask(current.pass, translate("Change in {0}: ", PASS_INFO[current.pass].the))}>{translate("Request changes")}</Button>
    </>;
  } else {
    const first = !view.lastApproved;
    title = `Siguiente: ${lower(current.pass)}.`;
    body = first
      ? translate("Steps of this video: {0}. {1} You can remove or add steps in \"• •.\"", passList(plan, "label"), view.mode === "guided" ? translate("The agent for each of you to approve.") : translate("The agent makes them straight and you check everything in the end."))
      : translate("You've already approved {0}.", PASS_INFO[view.lastApproved!].the);
    actions = <>
      <Button size="sm" variant="primary" disabled={blocked} onClick={() => proceed(first ? translate("Start with the {0} pass.", lower(current.pass)) : translate("Keep going with the {0} pass.", lower(current.pass)))}>{first ? "Empezar por" : translate("Continue with")} {PASS_INFO[current.pass].the}</Button>
      <Button size="sm" variant="ghost" disabled={blocked} title={translate("Approval {0} unchanged, as seen now", PASS_INFO[current.pass].the)} onClick={() => approve(current.pass, false)}>{translate("That's it")}</Button>
    </>;
  }
  const hint = asking === "start"
    ? translate("Finish the phrase down here and send it, for example:... \"a 30-second reel with subtitles and music; the video is already cut.\"")
    : asking ? translate("Write down what to change and send it, for example: \"{0}.\"", PASS_INFO[asking].example) : null;

  return <section className="passes-now" role="status" aria-label={translate("Next step")}>
    <p><strong>{title}</strong> {body}</p>
    {notes.length > 0 && <details className="passes-notes">
      <summary><EditorIcon name="next" /><span>{translate("What has changed")}</span></summary>
      {notes.map((n) => <blockquote key={n.pass}>{notes.length > 1 && <b>{PASS_INFO[n.pass].label}: </b>}{n.note}</blockquote>)}
    </details>}
    <div className="passes-actions">{actions}</div>
    {hint && <p className="passes-hint">{hint}</p>}
    {error && <p className="passes-error" role="alert">{error}</p>}
    {notice && <p className="passes-notice">{notice}</p>}
  </section>;
}

/** Where the project stands, in the top bar: it opens the passes next to the chat. */
export function PassChip({ passes, busy, onOpen }: { passes: PassesView; busy: boolean; onOpen: () => void }) {
  if (!passes.started) return null;
  const current = passes.current ? passes.passes.find((x) => x.pass === passes.current)! : null;
  const status = !current ? "approved" : busy && current.status === "working" ? "working" : current.status;
  return <button type="button" className="passes-chip" data-status={status} onClick={onOpen} title={translate("See the past and the versions")}>
    <i aria-hidden />
    {!passes.planned ? <span><strong>{translate("Steps to choose")}</strong></span>
      : current ? <span>{translate("Pass:")} <strong>{PASS_INFO[current.pass].label}</strong> · {current.status === "working" && !busy ? translate("not finished") : PASS_STATUS_LABELS[current.status].toLowerCase()}</span>
      : <span><strong>{passes.passes.some((x) => x.status === "approved") ? translate("All approved") : translate("Ready to export")}</strong></span>}
  </button>;
}

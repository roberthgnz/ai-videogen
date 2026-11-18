"use client";

import { t as translate } from "@/lib/i18n";
import { useState, useTransition } from "react";
import { Dialog as D } from "radix-ui";
import { ConfirmDialog } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/dropdown-menu";
import { deleteProjectFromHomeAction, renameProjectAction } from "./actions";
import { openProjectWindow, saveVideo } from "@/lib/desktop";

/**
 * The "⋯" on a project card: open, rename, download the finished video and
 * delete (behind a confirmation). It sits over the card's link, not inside it,
 * so the link and the menu stay separate controls.
 */
export function ProjectCardMenu({ id, name, downloadUrl, libraryCount = 0 }: { id: string; name: string; downloadUrl: string | null; libraryCount?: number }) {
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  /** Off by default: what the project made stays in the library unless asked otherwise. */
  const [removeAssets, setRemoveAssets] = useState(false);
  const [draft, setDraft] = useState(name);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <>
      <Menu>
        <MenuTrigger asChild>
          <button type="button" className="project-card-menu" aria-label={`Acciones de «${name}»`}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <circle cx="5" cy="12" r="1.9" />
              <circle cx="12" cy="12" r="1.9" />
              <circle cx="19" cy="12" r="1.9" />
            </svg>
          </button>
        </MenuTrigger>
        <MenuContent align="end">
          <MenuItem icon={<OpenIcon />} onSelect={() => { void openProjectWindow(id).catch(() => setError(translate("The project could not be opened."))); }}>{translate("Open in new window")}</MenuItem>
          <MenuItem icon={<PencilIcon />} onSelect={() => { setDraft(name); setError(null); setRenaming(true); }}>{translate("Change Name")}</MenuItem>
          {downloadUrl && (
            <MenuItem icon={<DownloadIcon />} onSelect={() => { void saveVideo(downloadUrl, `${name}.mp4`).catch(() => setError(translate("You couldn't save the video."))); }}>{translate("Download MP4")}</MenuItem>
          )}
          <MenuSeparator />
          <MenuItem icon={<TrashIcon />} destructive onSelect={() => { setError(null); setRemoveAssets(false); setDeleting(true); }}>{translate("Delete Project")}</MenuItem>
        </MenuContent>
      </Menu>
      {error && !renaming && !deleting && <p role="alert" className="text-sm text-danger">{error}</p>}

      <D.Root open={renaming} onOpenChange={(open) => { if (!pending) setRenaming(open); }}>
        <D.Portal>
          <D.Overlay className="ui-overlay fixed inset-0 z-50 bg-transparent" />
          <D.Content className="ui-pop ui-dialog fixed left-1/2 top-1/2 z-50 w-[min(420px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-[18px] p-6">
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                startTransition(async () => {
                  const result = await renameProjectAction(id, draft);
                  if (result.ok) setRenaming(false);
                  else setError(result.error);
                });
              }}
            >
              <D.Title className="text-lg font-semibold tracking-tight">{translate("Change Name")}</D.Title>
              <D.Description className="sr-only">{translate("New project name")}</D.Description>
              <input
                autoFocus
                value={draft}
                maxLength={120}
                onChange={(e) => setDraft(e.target.value)}
                onFocus={(e) => e.currentTarget.select()}
                aria-label={translate("Project name")}
                className="ui-field h-11 w-full rounded-xl px-3 text-sm"
              />
              {error && <p role="alert" className="rounded-xl bg-danger/15 px-3 py-2 text-sm text-danger">{error}</p>}
              <div className="flex justify-end gap-2">
                <D.Close asChild>
                  <Button variant="ghost" disabled={pending}>{translate("Cancel")}</Button>
                </D.Close>
                <Button type="submit" variant="primary" disabled={pending || !draft.trim() || draft.trim() === name}>
                  {pending ? translate("Saving…") : translate("Save")}
                </Button>
              </div>
            </form>
          </D.Content>
        </D.Portal>
      </D.Root>

      <ConfirmDialog
        open={deleting}
        onOpenChange={(open) => { if (!pending) { setDeleting(open); if (!open) setError(null); } }}
        title={translate("Delete \"{0}\"?", name)}
        description={
          libraryCount > 0 && !removeAssets
            ? translate("Your script and versions are deleted. Your files are still in the library. It can't be undone.")
            : translate("Your script, videos and files are deleted. It can't be undone.")
        }
        confirmLabel="Borrar proyecto"
        pending={pending}
        error={error}
        onConfirm={() =>
          startTransition(async () => {
            const result = await deleteProjectFromHomeAction(id, removeAssets);
            if (result.ok) setDeleting(false);
            else setError(result.error);
          })
        }
      >
        {libraryCount > 0 && (
          <label className="mt-4 flex cursor-pointer items-start gap-2.5 rounded-[10px] bg-fill px-3 py-2.5 text-left text-[13px] leading-[1.4]">
            <input
              type="checkbox"
              className="mt-px size-4 flex-none cursor-pointer accent-[var(--danger)]"
              checked={removeAssets}
              disabled={pending}
              onChange={(e) => setRemoveAssets(e.target.checked)}
            />
            <span>{translate("Remove also")} {libraryCount === 1 ? translate("your file") : translate("your {0} files", libraryCount)}{translate("from the library")}<span className="block text-[12px] text-muted">{translate("Those who use another project are preserved.")}</span>
            </span>
          </label>
        )}
      </ConfirmDialog>
    </>
  );
}

function OpenIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M14 4h6v6M20 4l-9 9M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" />
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />
    </svg>
  );
}

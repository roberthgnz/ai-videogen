"use client";

import { t as translate, localizedLabels } from "@/lib/i18n";
import { useRef, useState } from "react";
import Image from "next/image";
import { Dialog } from "radix-ui";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/alert-dialog";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip } from "@/components/ui/tooltip";
import { saveVideo } from "@/lib/desktop";
import { shortTime } from "@/lib/editing/timeline";
import { EditorIcon, type EditorIconName } from "../projects/[id]/desktop-controls";
import type { GlobalAsset } from "@/lib/db/schema";
import "../projects/[id]/asset-card.css";
import "./global-asset-card.css";

const KIND_ICON: Record<GlobalAsset["kind"], EditorIconName> = {
  video: "film",
  image: "media",
  audio: "music",
  document: "script",
};

const KIND_LABEL: Record<GlobalAsset["kind"], string> = localizedLabels((translate) => ({
  video: translate("Video"),
  image: translate("Image"),
  audio: "Audio",
  document: translate("Document"),
}));

const SOURCE_LABEL: Record<GlobalAsset["source"], string> = localizedLabels((translate) => ({
  upload: translate("Uploaded file"),
  generated: translate("AI-generated"),
  stock: "Stock",
}));

export function globalAssetUrl(asset: GlobalAsset) {
  return `/api/files/${asset.path.split("/").map(encodeURIComponent).join("/")}`;
}

export function globalThumbnailUrl(asset: GlobalAsset) {
  if (asset.kind === "video" || asset.kind === "image") {
    return `/api/media/global/${asset.id}/thumbnail`;
  }
  return "";
}

interface Props {
  asset: GlobalAsset;
  disabled?: boolean;
  inProject?: boolean;
  onAddToProject?: () => void;
  onDelete?: () => Promise<string | null>;
  onDragStart?: (e: React.DragEvent) => void;
  /** A click on the cover opens the preview (the library page; in the studio a double click adds instead). */
  previewOnClick?: boolean;
  /** Selection mode: a click picks the card instead of opening it. */
  selecting?: boolean;
  selected?: boolean;
  /** Toggles this card. Also reached with ⌘/Ctrl-click outside selection mode; the event carries Shift for ranges. */
  onToggleSelect?: (e: React.MouseEvent) => void;
}

export function GlobalAssetCard({
  asset,
  disabled = false,
  inProject = false,
  onAddToProject,
  onDelete,
  onDragStart,
  previewOnClick = false,
  selecting = false,
  selected = false,
  onToggleSelect,
}: Props) {
  const [previewOpen, setPreviewOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hovering, setHovering] = useState(false);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const visual = asset.kind === "video" || asset.kind === "image";
  const media = asset.kind !== "document";
  const url = globalAssetUrl(asset);
  const thumb = globalThumbnailUrl(asset);

  return (
    <div
      className={`pro-asset-card asset-card global-asset-card${selecting ? " is-selecting" : ""}${selected ? " is-selected" : ""}`}
      draggable={media && !disabled && !!onDragStart}
      onDragStart={onDragStart}
      onMouseEnter={() => {
        if (asset.kind === "video") hoverTimer.current = setTimeout(() => setHovering(true), 350);
      }}
      onMouseLeave={() => {
        if (hoverTimer.current) clearTimeout(hoverTimer.current);
        setHovering(false);
      }}
    >
      <div
        className="pro-asset-preview"
        onDoubleClick={disabled || !media || !onAddToProject ? undefined : onAddToProject}
      >
        {visual ? (
          <Image src={thumb} alt="" width={240} height={150} unoptimized draggable={false} />
        ) : (
          <EditorIcon name={KIND_ICON[asset.kind]} />
        )}
        {(previewOnClick || selecting) && (
          <button
            type="button"
            className="global-asset-open"
            aria-label={selecting ? translate("Select {0}", asset.name) : translate("Preview of {0}", asset.name)}
            aria-pressed={selecting ? selected : undefined}
            onClick={(e) => {
              if (onToggleSelect && (selecting || e.metaKey || e.ctrlKey)) onToggleSelect(e);
              else setPreviewOpen(true);
            }}
          />
        )}
        {selecting && (
          <span className="global-asset-check" aria-hidden>
            {selected && <EditorIcon name="check" />}
          </span>
        )}
        {hovering && (
          <video
            className="asset-card-live"
            src={url}
            muted
            autoPlay
            loop
            playsInline
            preload="metadata"
            aria-hidden
          />
        )}
        <span className="asset-card-badge">
          <EditorIcon name={asset.kind === "video" ? "play" : KIND_ICON[asset.kind]} />
          {asset.duration > 0 && shortTime(asset.duration)}
        </span>

        {inProject && <span className="global-in-project-badge">{translate("In the project")}</span>}

        <div className="asset-card-tools" role="toolbar" aria-label={translate("Actions for {0}", asset.name)}>
          {media && onAddToProject && (
            <Tooltip content={inProject ? translate("It's already on the project") : translate("Add to current project")}>
              <button
                type="button"
                aria-label={translate("Add {0} to project", asset.name)}
                disabled={disabled}
                onClick={onAddToProject}
              >
                <EditorIcon name="plus" />
              </button>
            </Tooltip>
          )}
          <Tooltip content={translate("Preview")}>
            <button
              type="button"
              aria-label={translate("Preview of {0}", asset.name)}
              onClick={() => setPreviewOpen(true)}
            >
              <EditorIcon name="expand" />
            </button>
          </Tooltip>
          <Menu>
            <MenuTrigger asChild>
              <button type="button" aria-label={translate("More actions for {0}", asset.name)}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                  <circle cx="5" cy="12" r="1.8" />
                  <circle cx="12" cy="12" r="1.8" />
                  <circle cx="19" cy="12" r="1.8" />
                </svg>
              </button>
            </MenuTrigger>
            <MenuContent align="end">
              {media && onAddToProject && (
                <MenuItem icon={<EditorIcon name="plus" />} disabled={disabled} onSelect={onAddToProject}>{translate("Add to project")}</MenuItem>
              )}
              <MenuItem icon={<EditorIcon name="expand" />} onSelect={() => setPreviewOpen(true)}>{translate("Preview")}</MenuItem>
              {media && (
                <MenuItem
                  icon={<EditorIcon name="import" />}
                  onSelect={() => {
                    void saveVideo(url, asset.name).catch(() => setError(translate("You couldn't save the file.")));
                  }}
                >{translate("Download")}</MenuItem>
              )}
              {onDelete && (
                <>
                  <MenuSeparator />
                  <MenuItem
                    icon={<EditorIcon name="trash" />}
                    destructive
                    disabled={disabled}
                    onSelect={() => {
                      setError(null);
                      setConfirming(true);
                    }}
                  >{translate("Remove from library")}</MenuItem>
                </>
              )}
            </MenuContent>
          </Menu>
        </div>
      </div>

      <div className="pro-asset-name" title={asset.name}>
        {asset.name}
      </div>
      <small>
        {SOURCE_LABEL[asset.source]} · {KIND_LABEL[asset.kind]}
        {asset.width ? ` · ${asset.width} × ${asset.height}` : ""}
      </small>
      {error && !confirming && (
        <small className="asset-card-error" role="alert">
          {error}
        </small>
      )}

      {/* Preview Dialog */}
      <Dialog.Root open={previewOpen} onOpenChange={setPreviewOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="ui-overlay fixed inset-0 z-50" />
          <Dialog.Content className="ui-pop ui-dialog asset-preview-dialog">
            <header>
              <Dialog.Title>{asset.name}</Dialog.Title>
              <Dialog.Close asChild>
                <Button size="icon-sm" aria-label={translate("Close preview")}>
                  <EditorIcon name="close" />
                </Button>
              </Dialog.Close>
            </header>
            <Dialog.Description className="sr-only">{translate("Preview of file")}</Dialog.Description>
            <div className="asset-preview-stage">
              {asset.kind === "video" ? (
                <video src={url} controls autoPlay playsInline />
              ) : asset.kind === "image" ? (
                <Image
                  src={url}
                  alt={asset.name}
                  width={asset.width || 1280}
                  height={asset.height || 720}
                  unoptimized
                />
              ) : asset.kind === "audio" ? (
                <audio src={url} controls autoPlay />
              ) : (
                <a href={url} target="_blank" rel="noreferrer">{translate("Open document ↗")}</a>
              )}
            </div>
            <footer>
              <span>
                {KIND_LABEL[asset.kind]} · {SOURCE_LABEL[asset.source]}
                {asset.duration > 0 ? ` · ${shortTime(asset.duration)}` : ""}
                {asset.width ? ` · ${asset.width} × ${asset.height}` : ""}
              </span>
              {media && onAddToProject && (
                <Button
                  variant="primary"
                  size="sm"
                  disabled={disabled}
                  onClick={() => {
                    onAddToProject();
                    setPreviewOpen(false);
                  }}
                >
                  <EditorIcon name="plus" />{translate("Add to project")}</Button>
              )}
            </footer>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {/* Confirm Delete Dialog */}
      {onDelete && (
        <ConfirmDialog
          open={confirming}
          onOpenChange={(open) => {
            if (!removing) setConfirming(open);
          }}
          title={translate("Remove \"{0}\" from the library?", asset.name)}
          description={translate("Stop showing up in the library. The projects that already use it keep their copy.")}
          confirmLabel={translate("Remove File")}
          pending={removing}
          error={error}
          onConfirm={async () => {
            setRemoving(true);
            const failed = await onDelete();
            setRemoving(false);
            if (failed) setError(failed);
            else setConfirming(false);
          }}
        />
      )}
    </div>
  );
}

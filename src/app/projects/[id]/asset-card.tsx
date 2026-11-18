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
import { assetUrl, type EditAsset } from "@/lib/editing/schema";
import { shortTime, thumbnailUrl } from "@/lib/editing/timeline";
import { EditorIcon, type EditorIconName } from "./desktop-controls";
import "./asset-card.css";

/** A file still on its way up: shown in the library with its progress. */
export interface UploadingFile { key: string; name: string; progress: number; preview: string | null; kind: EditAsset["kind"] }

const KIND_ICON: Record<EditAsset["kind"], EditorIconName> = { video: "film", image: "media", audio: "music", document: "script" };
const KIND_LABEL: Record<EditAsset["kind"], string> = localizedLabels((translate) => ({ video: translate("Video"), image: translate("Image"), audio: "Audio", document: "Documento" }));

interface Props {
  projectId: string;
  asset: EditAsset;
  disabled: boolean;
  /** On the timeline or guiding as a reference: it cannot be removed. */
  inUse: boolean;
  onAdd: () => void;
  onReference: () => void;
  onRemove: () => Promise<string | null>;
  onDragStart: (e: React.DragEvent) => void;
}

/** A library file: hover tools (add, reference, preview, more), a type badge, a live preview of videos. */
export function AssetCard({ projectId, asset, disabled, inUse, onAdd, onReference, onRemove, onDragStart }: Props) {
  const [previewOpen, setPreviewOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hovering, setHovering] = useState(false);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const visual = asset.kind === "video" || asset.kind === "image";
  const media = asset.kind !== "document";
  return <div className="pro-asset-card asset-card" draggable={media && !disabled} onDragStart={onDragStart}
    onMouseEnter={() => { if (asset.kind === "video") hoverTimer.current = setTimeout(() => setHovering(true), 350); }}
    onMouseLeave={() => { if (hoverTimer.current) clearTimeout(hoverTimer.current); setHovering(false); }}>
    <div className="pro-asset-preview" onDoubleClick={disabled || !media ? undefined : onAdd}>
      {visual ? <Image src={thumbnailUrl(projectId, asset)} alt={asset.name} width={240} height={150} unoptimized draggable={false} /> : <EditorIcon name={KIND_ICON[asset.kind]} />}
      {hovering && <video className="asset-card-live" src={assetUrl(asset)} muted autoPlay loop playsInline preload="metadata" aria-hidden />}
      <span className="asset-card-badge"><EditorIcon name={asset.kind === "video" ? "play" : KIND_ICON[asset.kind]} />{asset.duration > 0 && shortTime(asset.duration)}</span>
      <div className="asset-card-tools" role="toolbar" aria-label={`Acciones de ${asset.name}`}>
        {media && <Tooltip content={translate("Add to timeline")}><button type="button" aria-label={translate("Add {0} to the timeline", asset.name)} disabled={disabled} onClick={onAdd}><EditorIcon name="plus" /></button></Tooltip>}
        <Tooltip content={translate("Use as agent reference")}><button type="button" aria-label={translate("Use {0} as reference", asset.name)} disabled={disabled} onClick={onReference}><EditorIcon name="brand" /></button></Tooltip>
        <Tooltip content={translate("Preview")}><button type="button" aria-label={translate("Preview of {0}", asset.name)} onClick={() => setPreviewOpen(true)}><EditorIcon name="expand" /></button></Tooltip>
        <Menu>
          <MenuTrigger asChild><button type="button" aria-label={translate("More {0} shares", asset.name)}><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden><circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" /></svg></button></MenuTrigger>
          <MenuContent align="end">
            {media && <MenuItem icon={<EditorIcon name="plus" />} disabled={disabled} onSelect={onAdd}>{translate("Add to timeline")}</MenuItem>}
            <MenuItem icon={<EditorIcon name="brand" />} disabled={disabled} onSelect={onReference}>{translate("Use as a reference")}</MenuItem>
            <MenuItem icon={<EditorIcon name="expand" />} onSelect={() => setPreviewOpen(true)}>{translate("Preview")}</MenuItem>
            {media && <MenuItem icon={<EditorIcon name="import" />} onSelect={() => { void saveVideo(assetUrl(asset), asset.name).catch(() => setError(translate("You couldn't save the file."))); }}>{translate("Download")}</MenuItem>}
            <MenuSeparator />
            <MenuItem icon={<EditorIcon name="trash" />} destructive disabled={disabled || inUse} onSelect={() => { setError(null); setConfirming(true); }}>{inUse ? translate("In use: cannot be removed") : translate("Remove from library")}</MenuItem>
          </MenuContent>
        </Menu>
      </div>
    </div>
    <div className="pro-asset-name" title={asset.name}>{asset.name}</div>
    <small>{KIND_LABEL[asset.kind]}{asset.width ? ` · ${asset.width} × ${asset.height}` : ""}</small>
    {error && !confirming && <small className="asset-card-error" role="alert">{error}</small>}

    <Dialog.Root open={previewOpen} onOpenChange={setPreviewOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="ui-overlay fixed inset-0 z-50" />
        <Dialog.Content className="ui-pop ui-dialog asset-preview-dialog">
          <header><Dialog.Title>{asset.name}</Dialog.Title><Dialog.Close asChild><Button size="icon-sm" aria-label={translate("Close preview")}><EditorIcon name="close" /></Button></Dialog.Close></header>
          <Dialog.Description className="sr-only">{translate("Preview of file")}</Dialog.Description>
          <div className="asset-preview-stage">
            {asset.kind === "video" ? <video src={assetUrl(asset)} controls autoPlay playsInline />
              : asset.kind === "image" ? <Image src={assetUrl(asset)} alt={asset.name} width={asset.width || 1280} height={asset.height || 720} unoptimized />
              : asset.kind === "audio" ? <audio src={assetUrl(asset)} controls autoPlay />
              : <a href={assetUrl(asset)} target="_blank" rel="noreferrer">{translate("Open document ↗")}</a>}
          </div>
          <footer><span>{KIND_LABEL[asset.kind]}{asset.duration > 0 ? ` · ${shortTime(asset.duration)}` : ""}{asset.width ? ` · ${asset.width} × ${asset.height}` : ""}</span>
            {media && <Button variant="primary" size="sm" disabled={disabled} onClick={() => { onAdd(); setPreviewOpen(false); }}><EditorIcon name="plus" />{translate("Add to timeline")}</Button>}</footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
    <ConfirmDialog open={confirming} onOpenChange={(open) => { if (!removing) setConfirming(open); }} title={translate("Remove \"{0}\"?", asset.name)}
      description={translate("The file of this project is deleted. The original of your computer is not touched.")} confirmLabel="Quitar archivo" pending={removing} error={error}
      onConfirm={async () => { setRemoving(true); const failed = await onRemove(); setRemoving(false); if (failed) setError(failed); else setConfirming(false); }} />
  </div>;
}

/** The placeholder of a file being uploaded, with its progress over its own preview. */
export function UploadingCard({ file }: { file: UploadingFile }) {
  return <div className="pro-asset-card asset-card is-uploading" aria-busy="true">
    <div className="pro-asset-preview">
      {file.preview && file.kind === "image" ? (
        // eslint-disable-next-line @next/next/no-img-element -- local blob preview, never optimizable
        <img src={file.preview} alt="" />
      ) : file.preview && file.kind === "video" ? <video src={`${file.preview}#t=0.1`} muted playsInline preload="metadata" /> : <EditorIcon name={KIND_ICON[file.kind]} />}
      <span className="asset-card-progress" role="status"><i />{file.progress >= 100 ? "Procesando…" : `Subiendo ${Math.round(file.progress)}%`}</span>
      <span className="asset-card-bar" aria-hidden><b style={{ width: `${Math.max(3, file.progress)}%` }} /></span>
    </div>
    <div className="pro-asset-name" title={file.name}>{file.name}</div>
    <small>{KIND_LABEL[file.kind]}</small>
  </div>;
}

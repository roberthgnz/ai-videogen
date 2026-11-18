"use client";

import { t as translate } from "@/lib/i18n";
import { useState } from "react";
import Image from "next/image";
import { Button } from "@/components/ui/button";
import { REFERENCE_ROLE_INFO, needsTranscript, referencePrompt, toggleReferenceRole } from "@/lib/editing/references";
import { REFERENCE_ROLES, referenceAssetIds, type EditDocument, type EditReference, type ReferenceRole } from "@/lib/editing/schema";
import { shortTime, thumbnailUrl } from "@/lib/editing/timeline";
import { EditorIcon, ToolButton } from "./desktop-controls";
import { StyleProfileCard } from "./style-profile-card";

interface Props {
  projectId: string;
  doc: EditDocument;
  disabled: boolean;
  onImport: () => void;
  onAdd: (reference: EditReference) => void;
  /** Changes one reference from its latest saved state (so quick successive changes all apply). */
  onUpdate: (id: string, update: (reference: EditReference) => EditReference) => void;
  onRemove: (id: string) => void;
  onTranscribe: (id: string) => void;
  onUse: (message: string) => void;
}

const emptyDraft = { title: "", roles: ["style"] as ReferenceRole[], url: "", content: "" };

/**
 * What guides the assistant without going into the cut: a video whose editing or script the user
 * likes, their brand, their product. Each reference says what it guides (one or several roles).
 */
export function ReferencesPanel({ projectId, doc, disabled, onImport, onAdd, onUpdate, onRemove, onTranscribe, onUse }: Props) {
  const [writing, setWriting] = useState(false);
  const [draft, setDraft] = useState(emptyDraft);
  const guides = referenceAssetIds(doc);
  const documents = doc.assets.filter((a) => a.kind === "document" && !guides.has(a.id));

  return <>
    <div className="pro-feature-intro"><span><EditorIcon name="brand" /></span><h3>{translate("Which guides the assistant.")}</h3><p>{translate("A video whose rhythm or script you like, your brand or your product. They don't enter the assembly: they teach you how to do it.")}</p></div>
    <StyleProfileCard projectId={projectId} disabled={disabled} hasReferences={doc.references.length > 0} onUse={onUse} />

    <button type="button" className="ref-upload" disabled={disabled} onClick={onImport}>
      <span><EditorIcon name="import" /></span>
      <strong>{translate("Up reference")}</strong>
      <small>{translate("Video, image, audio or document")}</small>
    </button>
    {!writing && <button type="button" className="ref-write" disabled={disabled} onClick={() => setWriting(true)}><EditorIcon name="plus" />{translate("Write or paste a link")}</button>}

    {writing && <form className="pro-reference-form" onSubmit={(e) => {
      e.preventDefault();
      onAdd({ id: crypto.randomUUID(), title: draft.title.trim(), roles: draft.roles, url: draft.url.trim(), content: draft.content });
      setDraft(emptyDraft); setWriting(false);
    }}>
      <input aria-label={translate("Name of reference")} required maxLength={160} value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} placeholder={translate("Name (e.g. \"Brand Guide\")")} />
      <RoleChips roles={draft.roles} disabled={false} onToggle={(role) => setDraft({ ...draft, roles: toggleReferenceRole({ ...draft, id: "draft", assetId: undefined }, role).roles })} />
      <input aria-label={translate("Reference link")} type="url" value={draft.url} onChange={(e) => setDraft({ ...draft, url: e.target.value })} placeholder={translate("Link (optional)")} />
      <textarea aria-label={translate("Content of the reference")} required={!draft.url} rows={4} maxLength={16000} value={draft.content} onChange={(e) => setDraft({ ...draft, content: e.target.value })} placeholder={draft.roles.includes("script") ? translate("Paste the script or describe its structure…") : "Colores, mensajes, pantallas, lo que debe notarse…"} />
      <div className="flex gap-2"><Button type="submit" variant="primary" size="sm">{translate("Save Reference")}</Button><Button size="sm" onClick={() => { setDraft(emptyDraft); setWriting(false); }}>{translate("Cancel")}</Button></div>
    </form>}

    {doc.references.map((r) => {
      const asset = r.assetId ? doc.assets.find((a) => a.id === r.assetId) : undefined;
      const visual = asset && (asset.kind === "video" || asset.kind === "image");
      const unread = needsTranscript(r, asset);
      return <article key={r.id} className="ref-card">
        {visual && <div className="ref-thumb">
          <Image src={thumbnailUrl(projectId, asset)} alt="" width={320} height={180} unoptimized draggable={false} />
          {asset.kind === "video" && <span>{shortTime(asset.duration)}</span>}
        </div>}
        <div className="ref-head">
          {!visual && <span className="ref-icon"><EditorIcon name={asset?.kind === "audio" ? "volume" : "brand"} /></span>}
          <h4 title={r.title}>{r.title}</h4>
          <ToolButton icon="close" label={asset ? translate("Remove Reference {0} (file passes to Files)", r.title) : translate("Remove Reference {0}", r.title)} disabled={disabled} onClick={() => onRemove(r.id)} />
        </div>
        <span className="ref-guides-label">{translate("Guide")}</span>
        <RoleChips roles={r.roles} disabled={disabled} onToggle={(role) => onUpdate(r.id, (current) => toggleReferenceRole(current, role))} />
        {unread
          ? <button type="button" className="ref-read" disabled={disabled} onClick={() => onTranscribe(r.id)}><EditorIcon name="captions" />{translate("Read your script")}</button>
          : (r.content || asset?.context) && <details className="ref-content"><summary>{r.roles.includes("script") && asset && asset.kind !== "document" ? translate("Read script") : translate("Content")}</summary><p>{r.content || asset?.context}</p></details>}
        {r.url && <a href={r.url} target="_blank" rel="noreferrer">{translate("Open link ↗")}</a>}
        <button type="button" className="ref-use" disabled={disabled} onClick={() => onUse(referencePrompt(r))}>{translate("Use with the assistant")} <EditorIcon name="sparkles" /></button>
      </article>;
    })}

    {documents.map((a) => <details key={a.id} className="pro-document"><summary><EditorIcon name="brand" />{a.name}</summary><p>{a.context}</p></details>)}
    {!!doc.references.length && <p className="pro-panel-note">{translate("The references are not placed in the timeline. Remove one to use your file as material.")}</p>}
  </>;
}

function RoleChips({ roles, disabled, onToggle }: { roles: ReferenceRole[]; disabled: boolean; onToggle: (role: ReferenceRole) => void }) {
  return <div className="ref-roles" role="group" aria-label={translate("What this reference guides")}>
    {REFERENCE_ROLES.map((role) => <button key={role} type="button" title={REFERENCE_ROLE_INFO[role].hint} aria-pressed={roles.includes(role)} disabled={disabled} onClick={() => onToggle(role)}>{REFERENCE_ROLE_INFO[role].label}</button>)}
  </div>;
}

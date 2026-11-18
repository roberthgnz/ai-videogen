"use client";

import { t as translate } from "@/lib/i18n";
import { useId } from "react";
import { Button, IconButton } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/field";
import { Select, SelectItem } from "@/components/ui/select";
import type { TemplateId } from "@/lib/domain";
import { countWords, estimateSeconds, MAX_NARRATION_CHARS } from "@/lib/script/schema";
import { getTemplate, templateList } from "@/templates/registry";
import type { FieldSpec, SceneContent } from "@/templates/types";
import { EditorIcon } from "./desktop-controls";
import type { SceneState } from "./editor-state";

/**
 * Hand editing of one scene, in the order someone thinks about it: what is said, what is read on screen,
 * what is seen behind, and how it sounds. The agent does the same from the chat; this is for the small fixes
 * that are quicker to type than to ask for. It opens inside the scene's own card (script-tools.tsx).
 */
export function SceneInspector({
  index,
  count,
  scene,
  issues,
  readOnly,
  onTemplate,
  onChange,
  onMove,
  onRemove,
  shots,
  shotsHint,
  audio,
  preview,
}: {
  index: number;
  /** How many scenes the script has: the first cannot go up, the last cannot go down. */
  count: number;
  scene: SceneState;
  /** What the last save found wrong with this scene. */
  issues?: string[];
  /** The agent is working on the project: edits now would be overwritten. */
  readOnly: boolean;
  onTemplate: (t: TemplateId) => void;
  onChange: (patch: Partial<SceneState>) => void;
  onMove: (delta: -1 | 1) => void;
  onRemove: () => void;
  /** The scene's images, or null when there are none yet (then `shotsHint` says how to get them). */
  shots: React.ReactNode;
  shotsHint: string;
  audio: React.ReactNode;
  preview: React.ReactNode;
}) {
  const id = useId();
  const template = getTemplate(scene.template);
  const words = countWords(scene.narration);
  const seconds = estimateSeconds(scene.narration).toFixed(1).replace(".", ",");

  return (
    <fieldset disabled={readOnly} className="script-fields">
      <legend className="sr-only">{translate("Scene")} {index + 1}</legend>

      {/* What moves or removes the scene sits on the scene, not at the end of its form. */}
      <div className="script-toolbar">
        <span>{translate("Scene")} {index + 1}{translate("of")} {count}</span>
        <IconButton label={translate("Move earlier")} size="icon-sm" tooltipSide="top" disabled={readOnly || index === 0} onClick={() => onMove(-1)}>↑</IconButton>
        <IconButton label={translate("Move after")} size="icon-sm" tooltipSide="top" disabled={readOnly || index === count - 1} onClick={() => onMove(1)}>↓</IconButton>
        <IconButton label={translate("Remove this scene")} size="icon-sm" tooltipSide="top" disabled={readOnly} onClick={onRemove}><EditorIcon name="trash" /></IconButton>
      </div>

      {issues?.length ? (
        <ul className="script-issues" role="alert">
          {issues.map((issue) => <li key={issue}>{issue}</li>)}
        </ul>
      ) : null}

      <section className="script-section">
        <header>
          <h4><label htmlFor={`${id}-narration`}>{translate("What the voice says")}</label></h4>
          <span>{words} {words === 1 ? "palabra" : "palabras"} · ~{seconds} s</span>
        </header>
        <Textarea
          id={`${id}-narration`}
          className="script-narration"
          value={scene.narration}
          maxLength={MAX_NARRATION_CHARS}
          rows={4}
          placeholder={translate("Write down what will be heard in this scene…")}
          onValueChange={(narration) => onChange({ narration })}
        />
      </section>

      <section className="script-section">
        <header><h4>{translate("What you read on screen")}</h4></header>
        <Field label={translate("Type of scene")} htmlFor={`${id}-template`}>
          <Select id={`${id}-template`} value={scene.template} onValueChange={(v) => onTemplate(v as TemplateId)} disabled={readOnly}>
            {templateList.map((t) => (
              <SelectItem key={t.id} value={t.id}>
                {t.label}
              </SelectItem>
            ))}
          </Select>
        </Field>
        {template.fields.map((field) => (
          <ContentField
            key={field.key}
            id={`${id}-${field.key}`}
            field={field}
            value={scene.content[field.key]}
            onChange={(value) => onChange({ content: { ...scene.content, [field.key]: value } })}
          />
        ))}
      </section>

      <section className="script-section">
        <header><h4>{translate("Background visuals")}</h4></header>
        {shots ?? <p className="script-hint">{shotsHint}</p>}
        <Field
          label={translate("What to look for")}
          htmlFor={`${id}-broll`}
          hint={translate("In English and separated by commas. If you leave it empty, they are chosen alone according to what the voice says.")}
        >
          <Input
            id={`${id}-broll`}
            value={scene.visualQueries}
            onValueChange={(visualQueries) => onChange({ visualQueries })}
            placeholder="ocean waves aerial, salt crystals macro"
          />
        </Field>
      </section>

      <section className="script-section">
        <header><h4>{translate("Voice")}</h4></header>
        {audio}
      </section>

      {preview}
    </fieldset>
  );
}

function ContentField({
  id,
  field,
  value,
  onChange,
}: {
  id: string;
  field: FieldSpec;
  value: SceneContent[string] | undefined;
  onChange: (value: string | string[]) => void;
}) {
  if (field.kind === "list") {
    const items = Array.isArray(value) ? value : [];
    return (
      <fieldset className="space-y-1.5">
        <legend className="mb-1 text-xs text-muted">
          {field.label}{translate("(up to")} {field.maxItems})
        </legend>
        {items.map((item, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <Input
              aria-label={`${field.label} ${i + 1}`}
              value={item}
              maxLength={field.maxLength}
              onValueChange={(value) => onChange(items.map((it, j) => (j === i ? value : it)))}
            />
            <IconButton
              label={translate("Remove item")}
              size="icon-sm"
              disabled={items.length <= field.minItems}
              onClick={() => onChange(items.filter((_, j) => j !== i))}
            >
              ✕
            </IconButton>
          </div>
        ))}
        {items.length < field.maxItems && (
          <Button variant="link" size="inline" onClick={() => onChange([...items, ""])}>{translate("+ Add Point")}</Button>
        )}
      </fieldset>
    );
  }

  const text = typeof value === "string" ? value : "";
  return (
    <Field label={`${field.label}${field.required ? "" : " (opcional)"}`} htmlFor={id} aside={`${text.length}/${field.maxLength}`}>
      <Input id={id} value={text} maxLength={field.maxLength} onValueChange={onChange} />
    </Field>
  );
}

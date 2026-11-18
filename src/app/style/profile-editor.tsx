"use client";

import { t as translate, localizedLabels } from "@/lib/i18n";
import { useId, useRef, useState, useTransition } from "react";
import Image from "next/image";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/field";
import { Select, SelectItem } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { EditorIcon } from "../projects/[id]/desktop-controls";
import {
  CAPTION_USE_LABELS,
  CAPTION_USES,
  FONT_FAMILIES,
  FONT_FAMILY_LABELS,
  FONT_WEIGHT_LABELS,
  FONT_WEIGHTS,
  GRAPHICS_DENSITIES,
  GRAPHICS_INFO,
  PACE_INFO,
  STYLE_PACES,
  captionPlace,
  type CaptionUse,
  type GraphicsDensity,
  type StyleFont,
  type StyleProfile,
  type StylePace,
  type StyleRule,
} from "@/lib/style-profile/schema";
import { libraryImagesAction } from "./actions";
import "./style.css";

const FAMILY_CSS: Record<StyleFont["family"], string> = { sans: "Arial, Helvetica, sans-serif", serif: "Georgia, 'Times New Roman', serif", mono: "'Courier New', monospace" };
const NONE = "none";
const RULE_SOURCE_LABEL: Record<StyleRule["source"], string> = localizedLabels((translate) => ({ manual: "Escrita por ti", learned: "Aprendida", references: translate("From your references") }));
const logoThumb = (assetId: string) => `/api/media/global/${assetId}/thumbnail`;

type LibraryImage = Awaited<ReturnType<typeof libraryImagesAction>>[number];

/**
 * Every field of a «Mi estilo» profile, grouped as a person thinks about their look: brand, colours, fonts,
 * logos, pace, subtitles, graphics, then free rules. Controlled: the parent keeps the draft and saves it.
 * Each field says what it changes in the videos and shows an example of what to write.
 */
export function ProfileEditor({ value, onChange, disabled = false }: { value: StyleProfile; onChange: (next: StyleProfile) => void; disabled?: boolean }) {
  const uid = useId();
  const set = (patch: Partial<StyleProfile>) => onChange({ ...value, ...patch });
  const p = value;

  return <div className="style-editor">
    <section className="style-card">
      <header><h2>{translate("Name and mark")}</h2><p>{translate("To recognize this style and for the assistant to speak as your brand.")}</p></header>
      <label className="style-field" htmlFor={`${uid}-name`}><span>{translate("Name")}</span>
        <Input id={`${uid}-name`} maxLength={80} value={p.name} disabled={disabled} onValueChange={(name) => set({ name })} placeholder={translate("e.g. My brand or Lumen client")} />
      </label>
      <label className="style-field" htmlFor={`${uid}-brand`}><span>{translate("Make and tone of voice")}</span>
        <Textarea id={`${uid}-brand`} rows={2} maxLength={800} value={p.brand} disabled={disabled} onValueChange={(brand) => set({ brand })} placeholder={translate("e. g. Close and expert, with energy. Short tutelage and phrases.")} />
      </label>
    </section>

    <ColorsSection value={p} onChange={onChange} disabled={disabled} />
    <FontsSection value={p} onChange={onChange} disabled={disabled} />
    <LogosSection value={p} onChange={onChange} disabled={disabled} />

    <section className="style-card">
      <header><h2>{translate("Rhythm of assembly")}</h2><p>{translate("Every time the plane changes, the assistant uses it when cutting your material.")}</p></header>
      <div className="style-row"><div><strong>{translate("Pacing")}</strong><span>{p.pacing.pace ? PACE_INFO[p.pacing.pace].hint : translate("Choose for each video.")}</span></div>
        <ToggleGroup<string> aria-label={translate("Rhythm of assembly")} value={p.pacing.pace ?? NONE} disabled={disabled} onValueChange={(v) => set({ pacing: { ...p.pacing, pace: v === NONE ? null : v as StylePace } })}>
          <ToggleGroupItem value={NONE}>{translate("Flexible")}</ToggleGroupItem>
          {STYLE_PACES.map((pace) => <ToggleGroupItem key={pace} value={pace} title={PACE_INFO[pace].hint}>{PACE_INFO[pace].label}</ToggleGroupItem>)}
        </ToggleGroup>
      </div>
      <div className="style-row"><div><strong>{translate("The usual plan")}</strong><span>{translate("Seconds that usually last each plane. Leave it empty to use the rhythm.")}</span></div>
        <div className="style-unit"><NumberField aria-label={translate("Normal plane duration in seconds")} min={0.2} max={30} decimals={1} value={p.pacing.shotSeconds} disabled={disabled}
          placeholder={p.pacing.pace ? String(PACE_INFO[p.pacing.pace].seconds).replace(".", ",") : "—"}
          onCommit={(shotSeconds) => set({ pacing: { ...p.pacing, shotSeconds } })} /><span>s</span></div>
      </div>
      <label className="style-field" htmlFor={`${uid}-pace-notes`}><span>{translate("Pacing notes")}</span>
        <Textarea id={`${uid}-pace-notes`} rows={2} maxLength={800} value={p.pacing.notes} disabled={disabled} onValueChange={(notes) => set({ pacing: { ...p.pacing, notes } })} placeholder={translate("For example, without breaks of more than 0.4. The hook, faster than the rest.")} />
      </label>
    </section>

    <CaptionsSection value={p} onChange={onChange} disabled={disabled} />

    <section className="style-card">
      <header><h2>{translate("Graphics and signs")}</h2><p>{translate("How many titles, labels and cards the assistant puts in addition to the subtitles.")}</p></header>
      <div className="style-row"><div><strong>{translate("Density")}</strong><span>{p.graphics.density ? GRAPHICS_INFO[p.graphics.density].hint : translate("Choose for each video.")}</span></div>
        <ToggleGroup<string> aria-label={translate("Number of graphs")} value={p.graphics.density ?? NONE} disabled={disabled} onValueChange={(v) => set({ graphics: { ...p.graphics, density: v === NONE ? null : v as GraphicsDensity } })}>
          <ToggleGroupItem value={NONE}>{translate("Flexible")}</ToggleGroupItem>
          {GRAPHICS_DENSITIES.map((d) => <ToggleGroupItem key={d} value={d} title={GRAPHICS_INFO[d].hint}>{d === "none" ? translate("None") : GRAPHICS_INFO[d].label}</ToggleGroupItem>)}
        </ToggleGroup>
      </div>
      <label className="style-field" htmlFor={`${uid}-graphics`}><span>{translate("How are they?")}</span>
        <Textarea id={`${uid}-graphics`} rows={2} maxLength={600} value={p.graphics.notes} disabled={disabled} onValueChange={(notes) => set({ graphics: { ...p.graphics, notes } })} placeholder={translate("For example, an idea per sign, they come in quickly and they come out clean.")} />
      </label>
    </section>

    <section className="style-card">
      <header><h2>{translate("Appearance and sound")}</h2><p>{translate("What does not fit in the above sections: coatings, color, transitions, music and effects.")}</p></header>
      <label className="style-field" htmlFor={`${uid}-look`}><span>{translate("Appearance")}</span>
        <Textarea id={`${uid}-look`} rows={3} maxLength={1200} value={p.look} disabled={disabled} onValueChange={(look) => set({ look })} placeholder={translate("e.g. closed plans, warm colors, dry cuts; soft approaches in important phrases.")} />
      </label>
      <label className="style-field" htmlFor={`${uid}-sound`}><span>{translate("Sound")}</span>
        <Textarea id={`${uid}-sound`} rows={2} maxLength={800} value={p.sound} disabled={disabled} onValueChange={(sound) => set({ sound })} placeholder={translate("For example, the voice always above. Soft music, a hit on the hook.")} />
      </label>
    </section>

    <RulesSection value={p} onChange={onChange} disabled={disabled} />
  </div>;
}

/**
 * A number typed freely (with comma or dot) and checked when the field is left: clamping on every key would turn
 * «0» into the minimum before «0,5» could be written. Empty commits null.
 */
function NumberField({ value, onCommit, min, max, decimals, placeholder, disabled, "aria-label": ariaLabel }: {
  value: number | null; onCommit: (value: number | null) => void; min: number; max: number; decimals: number;
  placeholder?: string; disabled?: boolean; "aria-label": string;
}) {
  const shown = value === null ? "" : String(value).replace(".", ",");
  const [text, setText] = useState(shown);
  const [editing, setEditing] = useState(false);
  const commit = () => {
    setEditing(false);
    const raw = text.trim().replace(",", ".");
    if (!raw) { onCommit(null); setText(""); return; }
    const n = Number(raw);
    if (!Number.isFinite(n)) { setText(shown); return; }
    const step = 10 ** decimals;
    const next = Math.min(max, Math.max(min, Math.round(n * step) / step));
    onCommit(next);
    setText(String(next).replace(".", ","));
  };
  return <Input inputMode={decimals ? "decimal" : "numeric"} aria-label={ariaLabel} placeholder={placeholder} disabled={disabled}
    value={editing ? text : shown} onFocus={() => { setText(shown); setEditing(true); }} onValueChange={setText} onBlur={commit}
    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); (e.target as HTMLInputElement).blur(); } }} />;
}

type SectionProps = { value: StyleProfile; onChange: (next: StyleProfile) => void; disabled: boolean };

function ColorsSection({ value: p, onChange, disabled }: SectionProps) {
  const setColor = (i: number, patch: Partial<StyleProfile["colors"][number]>) => onChange({ ...p, colors: p.colors.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
  return <section className="style-card">
    <header><h2>{translate("Colors")}</h2><p>{translate("For texts, boxes and signs. Give each one its use, so the assistant knows which one goes where.")}</p></header>
    {p.colors.length > 0 && <ul className="style-colors">
      {p.colors.map((c, i) => <li key={i}>
        <label className="style-swatch" style={{ background: c.hex }}><input type="color" aria-label={`Color ${i + 1}`} value={c.hex} disabled={disabled} onChange={(e) => setColor(i, { hex: e.target.value.toLowerCase() })} /></label>
        <code>{c.hex.toUpperCase()}</code>
        <Input aria-label={`Uso del color ${i + 1}`} maxLength={40} value={c.role} disabled={disabled} onValueChange={(role) => setColor(i, { role })} placeholder={translate("Purpose, e.g. Accent or Background")} />
        <Button size="icon-sm" variant="ghost" aria-label={`Quitar el color ${c.hex}`} disabled={disabled} onClick={() => onChange({ ...p, colors: p.colors.filter((_, j) => j !== i) })}><EditorIcon name="close" /></Button>
      </li>)}
    </ul>}
    {p.colors.length < 8 && <Button size="sm" variant="outline" disabled={disabled} onClick={() => onChange({ ...p, colors: [...p.colors, { hex: p.colors.length ? "#ffffff" : "#7c3aed", role: "" }] })}><EditorIcon name="plus" />{translate("Add Color")}</Button>}
  </section>;
}

function FontRow({ label, hint, font, onFont, disabled }: { label: string; hint: string; font: StyleFont; onFont: (f: StyleFont) => void; disabled: boolean }) {
  return <div className="style-font">
    <div className="style-font-head"><div><strong>{label}</strong><span>{hint}</span></div>
      <span className="style-font-sample" aria-hidden style={{ fontFamily: FAMILY_CSS[font.family], fontWeight: font.weight, fontStyle: font.italic ? "italic" : "normal" }}>{translate("Aa An idea")}</span>
    </div>
    <div className="style-font-controls">
      <Select aria-label={`Tipo de letra de ${label.toLowerCase()}`} value={font.family} disabled={disabled} onValueChange={(v) => onFont({ ...font, family: v as StyleFont["family"] })}>
        {FONT_FAMILIES.map((f) => <SelectItem key={f} value={f}>{FONT_FAMILY_LABELS[f]}</SelectItem>)}
      </Select>
      <Select aria-label={`Grosor de ${label.toLowerCase()}`} value={String(font.weight)} disabled={disabled} onValueChange={(v) => onFont({ ...font, weight: Number(v) })}>
        {FONT_WEIGHTS.map((w) => <SelectItem key={w} value={String(w)}>{FONT_WEIGHT_LABELS[w]}</SelectItem>)}
      </Select>
      <label className="style-switch"><Switch checked={font.italic} disabled={disabled} onCheckedChange={(italic) => onFont({ ...font, italic })} aria-label={`Cursiva en ${label.toLowerCase()}`} />{translate("Italic")}</label>
    </div>
    <Input aria-label={translate("Exact source of {0}", label.toLowerCase())} maxLength={60} value={font.name} disabled={disabled} onValueChange={(name) => onFont({ ...font, name })} placeholder={translate("Accurate (optional) source, e.g. \"Neue babies\": the most similar is used")} />
  </div>;
}

function FontsSection({ value: p, onChange, disabled }: SectionProps) {
  return <section className="style-card">
    <header><h2>{translate("Fonts")}</h2><p>{translate("The study draws three types of lyrics. If you want a specific source, write it: the assistant will use the most similar.")}</p></header>
    <FontRow label={translate("Titles")} hint={translate("Locks, signs and calls to action.")} font={p.fonts.titles} disabled={disabled} onFont={(titles) => onChange({ ...p, fonts: { ...p.fonts, titles } })} />
    <FontRow label={translate("Texts and subtitles")} hint={translate("Which goes with the voice.")} font={p.fonts.text} disabled={disabled} onFont={(text) => onChange({ ...p, fonts: { ...p.fonts, text } })} />
  </section>;
}

function LogosSection({ value: p, onChange, disabled }: SectionProps) {
  const [picking, setPicking] = useState(false);
  const [images, setImages] = useState<LibraryImage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, startLoading] = useTransition();
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const full = p.logos.length >= 6;

  const add = (image: { id: string; name: string; path: string }) => {
    if (p.logos.some((l) => l.assetId === image.id) || full) return;
    onChange({ ...p, logos: [...p.logos, { assetId: image.id, name: image.name, path: image.path, placement: "" }] });
  };
  const openPicker = () => {
    setPicking(true);
    setError(null);
    startLoading(async () => {
      const list = await libraryImagesAction().catch(() => null);
      if (list) setImages(list); else setError(translate("The library could not be opened."));
    });
  };
  async function upload(file: File) {
    setUploading(true);
    setError(null);
    try {
      const body = new FormData();
      body.append("file", file);
      const res = await fetch("/api/media/global", { method: "POST", body });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.asset) throw new Error(data.error || translate("You couldn't get the logo up."));
      if (data.asset.kind !== "image") throw new Error(translate("The logo must be a PNG, JPG or WebP image."));
      add(data.asset);
      setImages((list) => (list ? [data.asset, ...list] : list));
    } catch (e) {
      setError(e instanceof Error ? e.message : translate("You couldn't get the logo up."));
    } finally {
      setUploading(false);
    }
  }

  return <section className="style-card">
    <header><h2>{translate("Logos")}</h2><p>{translate("The assistant brings them to the project when he plays and places them wherever you say.")}</p></header>
    {p.logos.length > 0 && <ul className="style-logos">
      {p.logos.map((logo, i) => <li key={logo.assetId}>
        <span className="style-logo-thumb"><Image src={logoThumb(logo.assetId)} alt="" width={96} height={96} unoptimized draggable={false} /></span>
        <div><strong title={logo.name}>{logo.name}</strong>
          <Input aria-label={translate("Where are you going {0}", logo.name)} maxLength={200} value={logo.placement} disabled={disabled} onValueChange={(placement) => onChange({ ...p, logos: p.logos.map((l, j) => (j === i ? { ...l, placement } : l)) })} placeholder={translate("Where and when, e.g. \"top right corner, only at the end\"")} />
        </div>
        <Button size="icon-sm" variant="ghost" aria-label={`Quitar el logo ${logo.name}`} disabled={disabled} onClick={() => onChange({ ...p, logos: p.logos.filter((_, j) => j !== i) })}><EditorIcon name="close" /></Button>
      </li>)}
    </ul>}
    <div className="style-actions">
      <Button size="sm" variant="outline" disabled={disabled || full} aria-expanded={picking} onClick={() => (picking ? setPicking(false) : openPicker())}><EditorIcon name="media" />{picking ? translate("Close the library") : "Elegir de la biblioteca"}</Button>
      <Button size="sm" variant="ghost" disabled={disabled || full || uploading} onClick={() => fileRef.current?.click()}><EditorIcon name="import" />{uploading ? "Subiendo…" : translate("Up a logo")}</Button>
      <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" aria-label={translate("Up a logo to the library")} onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ""; if (file) void upload(file); }} />
      {full && <span className="style-muted">{translate("Up to 6 logos per style.")}</span>}
    </div>
    {picking && <div className="style-picker">
      {loading && !images ? <p className="style-muted">{translate("Loading images…")}</p>
        : images && images.length === 0 ? <p className="style-muted">{translate("Your library has no images yet. Get your logo up with \"Up a logo.\"")}</p>
        : <div className="style-picker-grid">{(images ?? []).map((img) => {
          const chosen = p.logos.some((l) => l.assetId === img.id);
          return <button type="button" key={img.id} aria-pressed={chosen} disabled={disabled || chosen || full} title={img.name} onClick={() => add(img)}>
            <Image src={logoThumb(img.id)} alt="" width={120} height={120} unoptimized draggable={false} /><span>{img.name}</span>
          </button>;
        })}</div>}
    </div>}
    {error && <p className="style-error" role="alert">{error}</p>}
  </section>;
}

const PLACES = localizedLabels((translate) => ([{ y: 12, label: translate("Up") }, { y: 45, label: translate("Center") }, { y: 75, label: translate("Down") }] as const));

function CaptionsSection({ value: p, onChange, disabled }: SectionProps) {
  const c = p.captions;
  const set = (patch: Partial<StyleProfile["captions"]>) => onChange({ ...p, captions: { ...c, ...patch } });
  const place = PLACES.find((x) => captionPlace(x.y) === captionPlace(c.y))!;
  const f = p.fonts.text;
  const sample = c.uppercase ? translate("THIS CHANGING ALL") : translate("This changes everything");
  return <section className="style-card">
    <header><h2>{translate("Subtitles")}</h2><p>{translate("If your videos carry subtitles, where they go and how they look. Preview is a vertical mobile.")}</p></header>
    <div className="style-captions">
      <div className="style-captions-fields">
        <div className="style-row"><div><strong>{translate("When")}</strong><span>{translate("\"According to the video\": it puts them if the request or reference requests them.")}</span></div>
          <ToggleGroup<CaptionUse> aria-label={translate("When they carry subtitles")} value={c.use} disabled={disabled} onValueChange={(use) => set({ use })}>
            {CAPTION_USES.map((u) => <ToggleGroupItem key={u} value={u}>{CAPTION_USE_LABELS[u]}</ToggleGroupItem>)}
          </ToggleGroup>
        </div>
        <div className="style-row"><div><strong>{translate("Position")}</strong><span>{translate("Up, in the center or down; fins with the bar.")}</span></div>
          <ToggleGroup<string> aria-label={translate("Position of subtitles")} value={place.label} disabled={disabled} onValueChange={(label) => set({ y: PLACES.find((x) => x.label === label)!.y })}>
            {PLACES.map((x) => <ToggleGroupItem key={x.label} value={x.label}>{x.label}</ToggleGroupItem>)}
          </ToggleGroup>
        </div>
        <input type="range" className="style-range" aria-label={translate("Height of subtitles")} min={0} max={90} value={c.y} disabled={disabled} onChange={(e) => set({ y: Number(e.target.value) })} />
        <div className="style-row"><div><strong>{translate("Words at once")}</strong><span>{translate("Few words are best read in quick videos.")}</span></div>
          <div className="style-unit"><NumberField aria-label={translate("Words by subtitle")} min={1} max={16} decimals={0} value={c.wordsPerCue} disabled={disabled} onCommit={(n) => set({ wordsPerCue: n ?? 3 })} /><span>{translate("words")}</span></div>
        </div>
        <div className="style-row"><div><strong>{translate("Size")}</strong><span>{c.fontSize}{translate("px on a 1080 px wide video.")}</span></div>
          <input type="range" className="style-range style-range-inline" aria-label={translate("Size of subtitles")} min={24} max={120} value={c.fontSize} disabled={disabled} onChange={(e) => set({ fontSize: Number(e.target.value) })} />
        </div>
        <div className="style-row"><div><strong>{translate("Colors")}</strong><span>{translate("Text, box behind (optional) and color to highlight the keyword.")}</span></div>
          <div className="style-caption-colors">
            <label className="style-swatch" title={translate("Text color")} style={{ background: c.color }}><input type="color" aria-label={translate("Text color")} value={c.color} disabled={disabled} onChange={(e) => set({ color: e.target.value.toLowerCase() })} /></label>
            <label className="style-switch"><Switch checked={c.background !== "transparent"} disabled={disabled} onCheckedChange={(on) => set({ background: on ? "#101018" : "transparent" })} aria-label={translate("Box behind the text")} />{translate("Box")}</label>
            {c.background !== "transparent" && <label className="style-swatch" title={translate("Box color")} style={{ background: c.background }}><input type="color" aria-label={translate("Box color")} value={c.background} disabled={disabled} onChange={(e) => set({ background: e.target.value.toLowerCase() })} /></label>}
            <label className="style-switch"><Switch checked={!!c.highlight} disabled={disabled} onCheckedChange={(on) => set({ highlight: on ? "#f2c84b" : "" })} aria-label={translate("Highlight the keyword")} />{translate("Highlight")}</label>
            {c.highlight && <label className="style-swatch" title={translate("Highlight color")} style={{ background: c.highlight }}><input type="color" aria-label={translate("Highlight color")} value={c.highlight} disabled={disabled} onChange={(e) => set({ highlight: e.target.value.toLowerCase() })} /></label>}
          </div>
        </div>
        <div className="style-row"><div><strong>{translate("Capital letters")}</strong><span>{translate("He writes the whole subtitle in capital letters.")}</span></div>
          <Switch checked={c.uppercase} disabled={disabled} onCheckedChange={(uppercase) => set({ uppercase })} aria-label={translate("Uppercase subtitles")} />
        </div>
      </div>
      <div className="style-phone" aria-hidden>
        <span className="style-phone-text" style={{
          top: `${c.y}%`, fontSize: `${c.fontSize / 1080 * 100}cqw`, color: c.color, background: c.background,
          fontFamily: FAMILY_CSS[f.family], fontWeight: f.weight, fontStyle: f.italic ? "italic" : "normal",
        }}>{c.highlight ? <>{sample.split(" ").slice(0, -1).join(" ")} <b style={{ color: c.highlight }}>{sample.split(" ").at(-1)}</b></> : sample}</span>
      </div>
    </div>
    <label className="style-field"><span>{translate("Notes of subtitles")}</span>
      <Textarea rows={2} maxLength={600} value={c.notes} disabled={disabled} onValueChange={(notes) => set({ notes })} placeholder={translate("For example, every word when I say it, minimum 0.4 s on screen. Never above my face.")} />
    </label>
  </section>;
}

function RulesSection({ value: p, onChange, disabled }: SectionProps) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const text = draft.trim();
    if (text.length < 3 || p.rules.length >= 80) return;
    onChange({ ...p, rules: [...p.rules, { id: crypto.randomUUID(), text, source: "manual", createdAt: Date.now() }] });
    setDraft("");
  };
  return <section className="style-card">
    <header><h2>{translate("Rules")}</h2><p>{translate("What the assistant must always do, in your words. Also appear here the corrections you accept from the chat.")}</p></header>
    {p.rules.length > 0 && <ol className="style-rules">
      {p.rules.map((r, i) => <li key={r.id}>
        <Input aria-label={translate("Rule {0}", i + 1)} maxLength={300} value={r.text} disabled={disabled} onValueChange={(text) => onChange({ ...p, rules: p.rules.map((x) => (x.id === r.id ? { ...x, text } : x)) })} />
        <span className="style-rule-source" data-source={r.source}>{r.source === "learned" && r.projectTitle ? `Aprendida en «${r.projectTitle}»` : RULE_SOURCE_LABEL[r.source]}</span>
        <Button size="icon-sm" variant="ghost" aria-label={translate("Remove the rule {0}", i + 1)} disabled={disabled} onClick={() => onChange({ ...p, rules: p.rules.filter((x) => x.id !== r.id) })}><EditorIcon name="close" /></Button>
      </li>)}
    </ol>}
    <form className="style-rule-add" onSubmit={(e) => { e.preventDefault(); add(); }}>
      <Input aria-label={translate("New rule")} maxLength={300} value={draft} disabled={disabled} onValueChange={setDraft} placeholder={translate("e.g. \"No emojis in the subtitles\" or \"Never cover my face with texts\"")} />
      <Button type="submit" size="sm" variant="outline" disabled={disabled || draft.trim().length < 3}><EditorIcon name="plus" />{translate("Add")}</Button>
    </form>
  </section>;
}

"use client";

import { t as translate } from "@/lib/i18n";
import { createContext, useContext, useRef, useState, useSyncExternalStore } from "react";
import { Dialog, Slider, Toolbar } from "radix-ui";
import { Button, type ButtonProps } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";

export type EditorIconName = "back" | "undo" | "redo" | "save" | "export" | "import" | "text" | "captions" | "play" | "pause" | "start" | "end" | "previous" | "next" | "split" | "trash" | "duplicate" | "guides" | "keyboard" | "close" | "volume" | "muted" | "media" | "sparkles" | "brand" | "search" | "plus" | "settings" | "expand" | "panel" | "magnet" | "ripple" | "check" | "transition" | "script" | "film" | "music" | "send" | "minus" | "chat";
const paths: Record<Exclude<EditorIconName, "play" | "pause">, string> = {
  text: "M5 7V5h14v2M12 5v14M9 19h6", captions: "M3 6h18v12H3V6Zm4 5h3m3 0h4M7 14h6m3 0h1", script: "M7 3h8l4 4v14H7V3Zm8 0v4h4M10 12h6M10 16h4",
  film: "M4 4h16v16H4V4Zm4 0v16m8-16v16M4 8h4m8 0h4M4 12h16M4 16h4m8 0h4", music: "M9 18V6l11-2v12M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm11-2a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z",
  send: "M12 19V5m-6 6 6-6 6 6", minus: "M5 12h14", chat: "M4 5h16v11H10l-5 4v-4H4V5Z",
  back: "M19 12H5m6-6-6 6 6 6", undo: "M9 5 4 10l5 5M4 10h10a6 6 0 0 1 0 12", redo: "m15 5 5 5-5 5m5-5H10a6 6 0 0 0 0 12",
  save: "M5 3h12l4 4v14H3V3h2m2 0v6h10V3M7 21v-8h10v8", export: "M12 16V3m-5 5 5-5 5 5M4 15v6h16v-6", import: "M12 3v13m-5-5 5 5 5-5M4 15v6h16v-6",
  start: "M5 5v14m14-13-9 6 9 6V6Z", end: "M19 5v14M5 6l9 6-9 6V6Z", previous: "m15 5-7 7 7 7", next: "m9 5 7 7-7 7",
  split: "M12 3v18M4 7h4v10H4m16-10h-4v10h4", trash: "M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7",
  duplicate: "M8 8h13v13H8V8ZM16 8V3H3v13h5", guides: "M8 3v18M16 3v18M3 8h18M3 16h18",
  keyboard: "M3 5h18v14H3V5Zm3 4h.01M10 9h.01M14 9h.01M18 9h.01M6 12h.01M10 12h.01M14 12h.01M18 12h.01M8 16h8", close: "m6 6 12 12M18 6 6 18",
  volume: "M3 9h4l5-4v14l-5-4H3V9Zm13-1a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14", muted: "M3 9h4l5-4v14l-5-4H3V9Zm13 0 6 6m0-6-6 6",
  transition: "M3 5h10v14H3V5Zm8 4h10v10H11V9Z", media: "M3 5h18v14H3V5Zm0 10 5-5 5 5m-2-2 4-4 6 6M16 8h.01", sparkles: "m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Zm7 0v4m-2-2h4", brand: "m12 3 9 5v8l-9 5-9-5V8l9-5Zm0 0v18M3 8l9 5 9-5", search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14Zm5-2 5 5", plus: "M12 5v14M5 12h14", settings: "M4 7h16M4 17h16M8 4v6m8 4v6", expand: "M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5", panel: "M3 4h18v16H3V4Zm12 0v16", magnet: "M5 3v9a7 7 0 0 0 14 0V3h-5v9a2 2 0 0 1-4 0V3H5Zm0 4h5m4 0h5", ripple: "M3 8h7v8H3V8Zm11 0h7v8h-7V8Zm-4 4h4M3 20h18", check: "m5 12 4 4L19 6",
};

export function EditorIcon({ name }: { name: EditorIconName }) {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill={name === "play" || name === "pause" ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {name === "play" ? <path d="m8 5 11 7-11 7V5Z" /> : name === "pause" ? <><path d="M6 5h4v14H6zM14 5h4v14h-4z" /></> : <path d={paths[name]} />}
  </svg>;
}

const ToolbarContext = createContext(false);
const subscribePlatform = () => () => {};
const isMac = () => /Mac|iPhone|iPad/.test(navigator.platform);
function shortcutLabel(shortcut: string, mac: boolean) {
  const label = shortcut.replace("Ctrl / ⌘", mac ? "⌘" : "Ctrl").replace("⇧", mac ? "⇧" : "Shift");
  return label.startsWith("⌘") ? label.replace(/\s/g, "") : label.startsWith("Ctrl") ? label.replace(/\s+/g, "+") : label;
}
export function EditorToolbar({ children }: { children: React.ReactNode }) {
  return <ToolbarContext.Provider value={true}><Toolbar.Root className="editor-toolbar" aria-label={translate("Editing tools")}>{children}</Toolbar.Root></ToolbarContext.Provider>;
}

export function ToolButton({ icon, label, shortcut, children, ...props }: Omit<ButtonProps, "aria-label"> & { icon: EditorIconName; label: string; shortcut?: string }) {
  const toolbar = useContext(ToolbarContext);
  const mac = useSyncExternalStore(subscribePlatform, isMac, () => false);
  const button = <Button aria-label={label} size={children ? "sm" : "icon-sm"} className="editor-tool" {...props}><EditorIcon name={icon} />{children}</Button>;
  return <Tooltip content={<span className="flex items-center gap-4"><span>{label}</span>{shortcut && <kbd className="editor-key">{shortcutLabel(shortcut, mac)}</kbd>}</span>}>
    <span className="inline-flex">{toolbar ? <Toolbar.Button asChild disabled={props.disabled}>{button}</Toolbar.Button> : button}</span>
  </Tooltip>;
}

const precision = (value: number) => String(Math.round(value * 1000) / 1000);
const numeric = (value: string) => Number(value.trim().replace(",", "."));

/** Incomplete drafts stay local. Enter/blur commits once; Escape restores the saved value. */
export function NumberField({ label, value, onChange, disabled, min = 0, max, step }: { label: string; value: number; onChange: (value: number) => void; disabled: boolean; min?: number; max: number; step?: number }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const cancel = useRef(false);
  const modified = useRef(false);
  const match = label.match(/\((s|%|px)\)$/);
  const unit = match?.[1];
  const increment = step ?? (unit === "px" ? 1 : 0.1);
  const clamp = (n: number) => Math.round(Math.max(min, Math.min(max, n)) * 1000) / 1000;
  function commit() {
    const n = numeric(draft);
    if (modified.current && !cancel.current && draft.trim() && Number.isFinite(n) && clamp(n) !== value) onChange(clamp(n));
    cancel.current = false;
    modified.current = false;
    setEditing(false);
  }
  function nudge(direction: number) {
    const base = editing && draft.trim() && Number.isFinite(numeric(draft)) ? numeric(draft) : value;
    const next = clamp(base + direction * increment);
    if (next !== value) onChange(next);
    modified.current = false;
    if (editing) setDraft(precision(next));
  }
  return <label className="editor-number-label">
    <span>{unit ? label.replace(/\s*\((s|%|px)\)$/, "") : label}</span>
    <span className={`editor-number ${disabled ? "is-disabled" : ""}`}>
      <input type="text" inputMode="decimal" role="spinbutton" aria-label={label} aria-valuenow={editing && draft.trim() && Number.isFinite(numeric(draft)) ? clamp(numeric(draft)) : value} aria-valuemin={min} aria-valuemax={max}
        value={editing ? draft : precision(value)} disabled={disabled}
        onFocus={(e) => { modified.current = false; setDraft(precision(value)); setEditing(true); e.currentTarget.select(); }}
        onChange={(e) => { modified.current = true; setDraft(e.target.value); }} onBlur={commit}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") e.currentTarget.blur();
          if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur(); }
          if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); cancel.current = true; e.currentTarget.blur(); }
          if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault(); e.stopPropagation();
            modified.current = true;
            const base = draft.trim() && Number.isFinite(numeric(draft)) ? numeric(draft) : value;
            setDraft(precision(clamp(base + (e.key === "ArrowUp" ? 1 : -1) * increment * (e.shiftKey ? 10 : 1))));
          }
        }} />
      {unit && <span aria-hidden className="editor-unit">{unit}</span>}
      <span className="editor-steppers">
        <button type="button" tabIndex={-1} aria-label={`Aumentar ${label}`} disabled={disabled || value >= max} onPointerDown={(e) => e.preventDefault()} onClick={() => nudge(1)}>⌃</button>
        <button type="button" tabIndex={-1} aria-label={`Reducir ${label}`} disabled={disabled || value <= min} onPointerDown={(e) => e.preventDefault()} onClick={() => nudge(-1)}>⌄</button>
      </span>
    </span>
  </label>;
}

export function VolumeField({ value, onChange, disabled }: { value: number; onChange: (value: number) => void; disabled: boolean }) {
  const [draft, setDraft] = useState<number | null>(null);
  const beforeMute = useRef(1);
  const percent = draft ?? Math.round(value * 100);
  return <div className="space-y-2"><div className="flex items-center justify-between text-[11px] text-muted"><span>{translate("Clip volume")}</span><span className="font-mono tabular-nums">{percent}%</span></div>
    <div className="flex items-center gap-2"><ToolButton icon={value === 0 ? "muted" : "volume"} label={value === 0 ? "Activar audio del clip" : translate("Silent clip")} disabled={disabled} onClick={() => { if (value > 0) { beforeMute.current = value; onChange(0); } else onChange(beforeMute.current); }} />
      <Slider.Root className="editor-slider" min={0} max={100} step={1} value={[percent]} disabled={disabled} onValueChange={([level]) => setDraft(level)} onValueCommit={([level]) => { setDraft(null); if (level / 100 !== value) onChange(level / 100); }}>
        <Slider.Track className="editor-slider-track"><Slider.Range className="editor-slider-range" /></Slider.Track><Slider.Thumb className="editor-slider-thumb" aria-label={translate("Clip volume")} />
      </Slider.Root>
    </div>
  </div>;
}

export function ColorField({ label, value, disabled, onChange }: { label: string; value: string; disabled: boolean; onChange: (value: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  return <label className="editor-number-label"><span>{label}</span><span className="editor-color">
    <input type="color" aria-label={label} value={value === "transparent" ? "#101018" : value} disabled={disabled} onChange={(e) => onChange(e.target.value)} />
    <input type="text" aria-label={`${label} hexadecimal`} value={draft ?? (value === "transparent" ? "—" : value.toUpperCase())} disabled={disabled} maxLength={7} spellCheck={false}
      onFocus={(e) => e.currentTarget.select()} onChange={(e) => setDraft(e.target.value)}
      onBlur={() => { if (draft && /^#?[0-9a-f]{6}$/i.test(draft)) onChange(draft.startsWith("#") ? draft : `#${draft}`); setDraft(null); }}
      onKeyDown={(e) => { if (e.key === "Enter" || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s")) e.currentTarget.blur(); if (e.key === "Escape") { setDraft(null); e.stopPropagation(); } }} />
  </span></label>;
}

export function KeyboardHelp({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const mac = useSyncExternalStore(subscribePlatform, isMac, () => false);
  const shortcuts = [[translate("Save"), "Ctrl / ⌘ S"], [translate("Import files"), "Ctrl / ⌘ O"], [translate("Export video"), "Ctrl / ⌘ ⇧ E"], [translate("Undo"), "Ctrl / ⌘ Z"], [translate("Redo"), "Ctrl / ⌘ ⇧ Z"], [translate("Play / pause"), translate("Space")], [translate("Focus mode"), "F"], [translate("Previous / next frame"), "← / →"], [translate("Go back / forward 1 s"), "⇧ ← / →"], [translate("Split clip"), "Ctrl / ⌘ B"], [translate("Double selection"), "Ctrl / ⌘ D"], [translate("Remove Selection"), "Supr / ⌫"], [translate("Deselect"), "Esc"], [translate("Move / cut focused clip"), "← / →"], [translate("Change the track-focused clip"), "↑ / ↓"], [translate("Drag without magnetic adjustment"), "Alt"], [translate("Cancel the drag"), "Esc"], [translate("Move text in one axis"), "⇧"]];
  return <Dialog.Root open={open} onOpenChange={onOpenChange}><Dialog.Portal>
    <Dialog.Overlay className="ui-overlay fixed inset-0 z-50" />
    <Dialog.Content className="ui-pop fixed left-1/2 top-1/2 z-50 max-h-[85dvh] w-[min(440px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-[18px] p-5 focus:outline-none">
      <div className="flex items-center justify-between"><Dialog.Title className="text-base font-semibold">{translate("Keyboard shortcuts")}</Dialog.Title><Dialog.Close asChild><Button size="icon-sm" aria-label={translate("Close shortcuts")}><EditorIcon name="close" /></Button></Dialog.Close></div>
      <Dialog.Description className="mt-1 text-xs text-muted">{translate("The editing shortcuts respect the text fields.")}</Dialog.Description>
      <dl className="mt-4 space-y-2.5">{shortcuts.map(([action, keys]) => <div key={action} className="flex items-center justify-between gap-4 text-xs"><dt>{action}</dt><dd><kbd className="editor-key">{shortcutLabel(keys, mac)}</kbd></dd></div>)}</dl>
    </Dialog.Content>
  </Dialog.Portal></Dialog.Root>;
}

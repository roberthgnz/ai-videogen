"use client";

import { t, localizedLabels } from "@/lib/i18n";
import { useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Field, Input, Label, Textarea } from "@/components/ui/field";
import { Select, SelectItem, SelectSeparator } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { CaptionStyleId, TransitionId, VideoFormat } from "@/lib/domain";
import { PRESET_IDS, STYLE_PRESETS, type PresetId } from "@/presets";
import type { Settings } from "./editor-state";
import { VoicePicker } from "./voice-picker";

const CAPTION_STYLE_OPTIONS: { id: CaptionStyleId; label: string; hint: string }[] = localizedLabels((t) => ([
  { id: "pop", label: "Pop", hint: t("1-3 giant words") },
  { id: "line", label: t("Line"), hint: "Frase con resaltado" },
  { id: "box", label: t("Box"), hint: t("Box after the word") },
]));

const TRANSITION_OPTIONS: { id: TransitionId; label: string }[] = localizedLabels((t) => ([
  { id: "auto", label: "Variadas (zoom, barrido, fundido)" },
  { id: "zoom", label: "Zoom" },
  { id: "slide", label: t("Slide") },
  { id: "fade", label: t("Fade") },
  { id: "cut", label: t("Dry cut") },
]));

const AUDIO_ACCEPT = ".mp3,.wav,.m4a,.aac,.ogg,.flac,audio/*";

const TONES = ["informative", "friendly", "playful", "inspiring", "serious", "energetic", "mysterious"];

/** Project-wide settings: style, format, voice, captions, music. */
export function SettingsPanel({
  settings,
  onChange,
  audioLibrary,
  readOnly,
}: {
  settings: Settings;
  onChange: (settings: Settings) => void;
  audioLibrary: { music: string[]; sfx: number };
  readOnly: boolean;
}) {
  const id = useId();
  const router = useRouter();
  const set = (patch: Partial<Settings>) => onChange({ ...settings, ...patch });
  const songRef = useRef<HTMLInputElement>(null);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const sfxRef = useRef<HTMLInputElement>(null);
  const [sfxNote, setSfxNote] = useState<string | null>(null);
  /** Adds a song to the music library and picks it for this video; or sound effects, turned on. */
  async function addSong(file: File, kind: "music" | "sfx" = "music") {
    if (kind === "music") { setAdding(true); setAddError(null); } else setSfxNote(t("Adding…"));
    try {
      const body = new FormData(); body.set("file", file);
      const response = await fetch(kind === "sfx" ? "/api/music?kind=sfx" : "/api/music", { method: "POST", body });
      const data = await response.json().catch(() => ({ error: t("The audio could not be added.") }));
      if (!response.ok) throw new Error(data.error);
      if (kind === "music") set({ music: data.name }); else { set({ sfx: true }); setSfxNote(null); }
      router.refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : t("The audio could not be added.");
      if (kind === "music") setAddError(message); else setSfxNote(message);
    } finally {
      setAdding(false);
    }
  }
  const strayMusic = settings.music !== "auto" && settings.music !== "none" && !audioLibrary.music.includes(settings.music);

  return (
    <fieldset disabled={readOnly} className="min-w-0 space-y-5">
      <legend className="sr-only">{t("Video settings")}</legend>

      <section className="space-y-2">
        <h3 className="text-xs text-muted">{t("Style")}</h3>
        <ToggleGroup<PresetId>
          variant="cards"
          aria-label={t("Style")}
          value={settings.preset}
          disabled={readOnly}
          onValueChange={(preset) => {
            const option = STYLE_PRESETS[preset];
            set({ preset, captionStyle: option.captionStyle, transition: option.transition });
          }}
        >
          {PRESET_IDS.map((presetId) => {
            const option = STYLE_PRESETS[presetId];
            return (
              <ToggleGroupItem key={presetId} value={presetId} variant="cards">
                <span className="flex items-center gap-2 text-sm font-medium">
                  <span aria-hidden className="h-3 w-3 rounded-full" style={{ background: option.accent }} />
                  {option.label}
                </span>
                <span className="block text-xs text-muted">{option.hint}</span>
              </ToggleGroupItem>
            );
          })}
        </ToggleGroup>
      </section>

      <Field label={t("Theme")} htmlFor={`${id}-topic`}>
        <Textarea id={`${id}-topic`} value={settings.topic} onValueChange={(topic) => set({ topic })} rows={2} maxLength={2000} />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label={t("Target duration (s)")} htmlFor={`${id}-duration`}>
          <Input
            id={`${id}-duration`}
            type="number"
            min={10}
            max={180}
            step={5}
            value={String(settings.targetDurationSec)}
            onValueChange={(value) => set({ targetDurationSec: Number(value) })}
          />
        </Field>
        <Field label={t("Tone")} htmlFor={`${id}-tone`}>
          <Input id={`${id}-tone`} list={`${id}-tones`} value={settings.tone} maxLength={60} onValueChange={(tone) => set({ tone })} />
          <datalist id={`${id}-tones`}>
            {TONES.map((tone) => (
              <option key={tone} value={t(tone)} />
            ))}
          </datalist>
        </Field>
      </div>

      <section className="space-y-1.5">
        <h3 className="text-xs text-muted">{t("Format")}</h3>
        <ToggleGroup<VideoFormat> aria-label={t("Format")} value={settings.format} disabled={readOnly} onValueChange={(format) => set({ format })}>
          <ToggleGroupItem value="vertical">9:16</ToggleGroupItem>
          <ToggleGroupItem value="horizontal">16:9</ToggleGroupItem>
        </ToggleGroup>
      </section>

      <section className="space-y-1.5">
        <h3 className="text-xs text-muted">{t("Subtitles")}</h3>
        <ToggleGroup<CaptionStyleId>
          variant="cards"
          aria-label={t("Subtitles")}
          className="grid-cols-3"
          value={settings.captionStyle}
          disabled={readOnly}
          onValueChange={(captionStyle) => set({ captionStyle })}
        >
          {CAPTION_STYLE_OPTIONS.map((option) => (
            <ToggleGroupItem key={option.id} value={option.id} variant="cards" title={option.hint} className="!px-2 !py-1.5 text-center">
              <span className="block text-sm">{option.label}</span>
              <span className="block text-[11px] leading-4 text-muted">{option.hint}</span>
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </section>

      <Field label={t("Transition between scenes")} htmlFor={`${id}-transition`}>
        <Select id={`${id}-transition`} value={settings.transition} disabled={readOnly} onValueChange={(v) => set({ transition: v as TransitionId })}>
          {TRANSITION_OPTIONS.map((option) => (
            <SelectItem key={option.id} value={option.id}>
              {option.label}
            </SelectItem>
          ))}
        </Select>
      </Field>

      <Field
        label={t("Background music")}
        htmlFor={`${id}-music`}
        hint={
          adding ? t("Adding the song…")
            : addError ?? (audioLibrary.music.length > 0
              ? t("{0} {1} in your library · comes down alone under the voice", audioLibrary.music.length, audioLibrary.music.length === 1 ? t("song") : "canciones")
              : t("Your music library is empty: add a song."))
        }
      >
        <div className="flex items-center gap-2">
          <input ref={songRef} type="file" accept={AUDIO_ACCEPT} hidden onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ""; if (file) void addSong(file); }} />
          <Button variant="outline" size="sm" disabled={readOnly || adding} onClick={() => songRef.current?.click()}>{t("Add song")}</Button>
          <a className="text-xs text-muted underline underline-offset-2 hover:text-foreground" href="https://pixabay.com/music/" target="_blank" rel="noreferrer">{t("Free music")}</a>
        </div>
        <Select id={`${id}-music`} value={settings.music} disabled={readOnly} onValueChange={(music) => set({ music })}>
          <SelectItem value="auto">{t("Automatic (one of your library)")}</SelectItem>
          <SelectItem value="none">{t("No music")}</SelectItem>
          {(audioLibrary.music.length > 0 || strayMusic) && <SelectSeparator />}
          {audioLibrary.music.map((name) => (
            <SelectItem key={name} value={name}>
              {name}
            </SelectItem>
          ))}
          {strayMusic && <SelectItem value={settings.music}>{settings.music}{t("(not in your library)")}</SelectItem>}
        </Select>
      </Field>

      <div className="flex items-start justify-between gap-3">
        <div>
          <Label htmlFor={`${id}-sfx`} className="block text-sm text-foreground">{t("Sound effects on transitions")}</Label>
          <p className="text-xs text-muted">
            {sfxNote ?? (audioLibrary.sfx > 0 ? t("{0} {1} in rotation · ", audioLibrary.sfx, audioLibrary.sfx === 1 ? "efecto" : "efectos") : t("No effects yet · "))}
            <input ref={sfxRef} type="file" accept={AUDIO_ACCEPT} hidden onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ""; if (file) void addSong(file, "sfx"); }} />
            <button type="button" className="underline underline-offset-2 hover:text-foreground disabled:opacity-50" disabled={readOnly} onClick={() => sfxRef.current?.click()}>{t("Add Effect")}</button>
          </p>
        </div>
        <Switch id={`${id}-sfx`} checked={settings.sfx} disabled={readOnly} onCheckedChange={(sfx) => set({ sfx })} />
      </div>

      <Field label={t("Voice")} htmlFor={`${id}-voice`}>
        <VoicePicker id={`${id}-voice`} value={settings.voiceId} onChange={(voiceId) => set({ voiceId })} />
      </Field>
    </fieldset>
  );
}

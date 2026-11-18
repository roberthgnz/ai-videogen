"use client";

import { t, localizedLabels } from "@/lib/i18n";
import type { LanguagePreference } from "@/lib/i18n/locale";
import { useEffect, useRef, useState, useSyncExternalStore, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { Select, SelectItem } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { isDesktop } from "@/lib/desktop";
import type { AgentProviderStatus, AppSettings, ExportQuality } from "@/lib/app-settings-shared";
import type { VideoFormat } from "@/lib/domain";
import { PRESET_IDS, STYLE_PRESETS, type PresetId } from "@/presets";
import { AgentPermissionOptions } from "../agent-permissions";
import { AgentProviderOptions } from "../agent-providers";
import { VoicePicker } from "../projects/[id]/voice-picker";
import { checkAgentProvidersAction, saveAppSettingsAction } from "../settings-actions";

export interface ServiceStatus { id: string; label: string; detail: string; ready: boolean }

type Theme = "light" | "dark" | "system";
const SECTIONS = localizedLabels((t) => ([["apariencia", t("Appearance")], ["agente", t("Agent")], ["proyectos", t("New projects")], ["exportacion", t("Export settings")], ["servicios", t("Services")]] as const));
const QUALITY: Record<ExportQuality, [string, string]> = localizedLabels((t) => ({ draft: [t("Draft"), t("Quick, to check")], looks: [t("Standard"), t("Balanced quality and render time")], delivery: [t("Highest quality"), t("For final delivery")] }));

function readTheme(): Theme {
  try { const t = localStorage.getItem("videogen-theme"); if (t === "light" || t === "dark" || t === "system") return t; } catch { /* storage blocked */ }
  return document.documentElement.dataset.theme === "system" ? "system" : "light";
}

/** Everything global, saved in one go; the theme applies at once because it only lives on this device. */
export function SettingsForm({ initial, services, providers: detected, storage }: { initial: AppSettings; services: ServiceStatus[]; providers: AgentProviderStatus[]; storage: string }) {
  const [draft, setDraft] = useState(initial);
  const [providers, setProviders] = useState(detected);
  const [checking, startCheck] = useTransition();
  const [saved, setSaved] = useState(JSON.stringify(initial));
  const [theme, setTheme] = useState<Theme>("light");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const reloading = useRef(false);
  const dirty = JSON.stringify(draft) !== saved;
  const desktop = useSyncExternalStore(() => () => {}, isDesktop, () => false);
  // The stored theme is only known in the browser.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setTheme(readTheme()), []);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { if (!reloading.current) e.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  // The sidebar says where you are: the last section whose top has passed under the bar. Two cases it would get
  // wrong on its own: the end of the page (the last sections are short and never reach the top, so there it is the
  // last one), and a section picked in the sidebar (it is the one marked, whatever the scroll could reach, until
  // the page is scrolled by hand again).
  const [section, setSection] = useState<string>(SECTIONS[0][0]);
  const picked = useRef(false);
  useEffect(() => {
    let frame = 0;
    const read = () => {
      frame = 0;
      if (picked.current) return;
      let current: string = SECTIONS[0][0];
      for (const [id] of SECTIONS) {
        const top = document.getElementById(id)?.getBoundingClientRect().top;
        if (top !== undefined && top <= 140) current = id;
      }
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2) current = SECTIONS[SECTIONS.length - 1][0];
      setSection(current);
    };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(read); };
    const byHand = () => { picked.current = false; };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("wheel", byHand, { passive: true });
    window.addEventListener("touchmove", byHand, { passive: true });
    window.addEventListener("keydown", byHand);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("wheel", byHand);
      window.removeEventListener("touchmove", byHand);
      window.removeEventListener("keydown", byHand);
    };
  }, []);

  const defaults = draft.defaults;
  const setDefaults = (patch: Partial<AppSettings["defaults"]>) => { setDraft({ ...draft, defaults: { ...defaults, ...patch } }); setMessage(null); };
  function chooseTheme(next: Theme) {
    setTheme(next);
    try { localStorage.setItem("videogen-theme", next); } catch { /* the choice still applies to this visit */ }
    document.documentElement.dataset.theme = next;
  }
  function recheck() {
    startCheck(async () => {
      const next = await checkAgentProvidersAction().catch(() => null);
      if (next) setProviders(next); else setMessage({ ok: false, text: t("It was not possible to check which programs are installed.") });
    });
  }
  function save() {
    start(async () => {
      const result = await saveAppSettingsAction(draft).catch(() => ({ ok: false as const, error: t("Could not save settings.") }));
      if (result.ok && result.settings.language !== initial.language) {
        reloading.current = true;
        window.location.reload();
        return;
      }
      if (result.ok) { setDraft(result.settings); setSaved(JSON.stringify(result.settings)); setMessage({ ok: true, text: t("Settings saved.") }); }
      else setMessage({ ok: false, text: result.error });
    });
  }

  return (
    <main className="settings">
      <nav className="settings-nav" aria-label={t("Sections")}>
        <h1>{t("Settings")}</h1>
        {SECTIONS.map(([id, label]) => <a key={id} href={`#${id}`} aria-current={section === id ? "location" : undefined} onClick={() => { picked.current = true; setSection(id); }}>{label}</a>)}
      </nav>
      <div className="settings-body">
        <section id="apariencia" className="settings-card">
          <header><h2>{t("Appearance")}</h2><p>{t("Set the theme and language for this device.")}</p></header>
          <div className="settings-row">
            <div><strong>{t("Language")}</strong><span>{t("Follow the operating system or choose a language for VideoGen.")}</span></div>
            <Select aria-label={t("Language")} value={draft.language} className="settings-select" onValueChange={(language) => { setDraft({ ...draft, language: language as LanguagePreference }); setMessage(null); }}>
              <SelectItem value="system">{t("System language")}</SelectItem>
              <SelectItem value="en">English</SelectItem>
              <SelectItem value="es">Español</SelectItem>
            </Select>
          </div>
          <div className="settings-row">
            <div><strong>{t("Theme")}</strong><span>{t("Light, dark, or follow the system theme.")}</span></div>
            <ToggleGroup<Theme> aria-label={t("Theme")} value={theme} onValueChange={chooseTheme}>
              <ToggleGroupItem value="light">{t("Light")}</ToggleGroupItem>
              <ToggleGroupItem value="dark">{t("Dark")}</ToggleGroupItem>
              <ToggleGroupItem value="system">{t("System")}</ToggleGroupItem>
            </ToggleGroup>
          </div>
        </section>

        <section id="agente" className="settings-card">
          <header><h2>{t("Agent engine")}</h2><p>{t("Choose which assistant runs the studio. Claude Code and Codex use your signed-in account, tools, and skills in the project folder and remember the conversation. Video edits use the studio tools. External commands ask for permission in chat unless automatic mode is on.")}</p></header>
          <AgentProviderOptions value={draft.agentProvider} statuses={providers} models={draft.agentModels} disabled={checking}
            onChange={(agentProvider) => { setDraft({ ...draft, agentProvider }); setMessage(null); }}
            onModel={(id, model) => { setDraft({ ...draft, agentModels: { ...draft.agentModels, [id]: model } }); setMessage(null); }} />
          <div className="agent-provider-actions">
            <Button variant="outline" size="sm" disabled={checking} onClick={recheck}>{checking ? t("Checking…") : t("Check again")}</Button>
            <span>{t("Check again after installing a program or signing in.")}</span>
          </div>
        </section>

        <section id="permisos" className="settings-card">
          <header><h2>{t("Agent permissions")}</h2><p>{t("Set when the assistant can generate voice or video automatically. Actions you click run immediately.")}</p></header>
          <AgentPermissionOptions mode={draft.agentMode} threshold={draft.agentThresholdSec} onMode={(agentMode) => { setDraft({ ...draft, agentMode }); setMessage(null); }} onThreshold={(agentThresholdSec) => { setDraft({ ...draft, agentThresholdSec }); setMessage(null); }} />
        </section>

        <section id="proyectos" className="settings-card">
          <header><h2>{t("New projects")}</h2><p>{t("Set defaults for new projects. Change them per project under Script → Voice and style.")}</p></header>
          <div className="settings-row">
            <div><strong>{t("Format")}</strong><span>{t("You can also choose a format on the home screen.")}</span></div>
            <ToggleGroup<VideoFormat> aria-label={t("Default format")} value={defaults.format} onValueChange={(format) => setDefaults({ format })}>
              <ToggleGroupItem value="vertical">9:16</ToggleGroupItem>
              <ToggleGroupItem value="horizontal">16:9</ToggleGroupItem>
            </ToggleGroup>
          </div>
          <div className="settings-row">
            <div><strong>{t("Style")}</strong><span>{t("Subtitles, transitions and accent color.")}</span></div>
            <Select aria-label={t("Default style")} value={defaults.preset} className="settings-select" onValueChange={(v) => setDefaults({ preset: v as PresetId })}
              leading={<span aria-hidden className="h-2.5 w-2.5 flex-none rounded-full" style={{ background: STYLE_PRESETS[defaults.preset].accent }} />}>
              {PRESET_IDS.map((id) => <SelectItem key={id} value={id} hint={STYLE_PRESETS[id].hint}>{STYLE_PRESETS[id].label}</SelectItem>)}
            </Select>
          </div>
          <div className="settings-row">
            <div><strong>{t("Voice")}</strong><span>{t("The narration voice for new videos.")}</span></div>
            <div className="settings-control-wide"><VoicePicker value={defaults.voiceId} onChange={(voiceId) => setDefaults({ voiceId })} /></div>
          </div>
          <div className="settings-row">
            <div><strong>{t("Target duration")}</strong><span>{t("The duration the assistant aims for when writing a script.")}</span></div>
            <Select aria-label={t("Target duration")} value={String(defaults.targetDurationSec)} className="settings-select" onValueChange={(v) => setDefaults({ targetDurationSec: Number(v) })}>
              {[15, 30, 45, 60, 90, 120, 180].map((s) => <SelectItem key={s} value={String(s)}>{s < 60 ? t("{0} seconds", s) : s === 60 ? t("1 minute") : t("{0} minutes", s / 60)}</SelectItem>)}
            </Select>
          </div>
          <div className="settings-row">
            <div><strong>{t("Tone")}</strong><span>{t("Describe the tone in a word or two, such as informative, friendly, or epic.")}</span></div>
            <Input aria-label={t("Default tone")} value={defaults.tone} maxLength={60} className="settings-input" onValueChange={(tone) => setDefaults({ tone })} />
          </div>
          <div className="settings-row">
            <div><strong>{t("Background music")}</strong><span>{t("Use a track from your music folder or leave the video without music.")}</span></div>
            <ToggleGroup<"auto" | "none"> aria-label={t("Default music")} value={defaults.music} onValueChange={(music) => setDefaults({ music })}>
              <ToggleGroupItem value="auto">{t("Automatic")}</ToggleGroupItem>
              <ToggleGroupItem value="none">{t("No music")}</ToggleGroupItem>
            </ToggleGroup>
          </div>
          <div className="settings-row">
            <div><strong>{t("Sound effects")}</strong><span>{t("Play sound effects during animated transitions.")}</span></div>
            <Switch aria-label={t("Default sound effects")} checked={defaults.sfx} onCheckedChange={(sfx) => setDefaults({ sfx })} />
          </div>
        </section>

        <section id="exportacion" className="settings-card">
          <header><h2>{t("Export settings")}</h2><p>{t("The quality selected when you open the export dialog.")}</p></header>
          <ToggleGroup<ExportQuality> aria-label={t("Default quality")} variant="cards" value={defaults.exportQuality} onValueChange={(exportQuality) => setDefaults({ exportQuality })} className="settings-quality">
            {(Object.keys(QUALITY) as ExportQuality[]).map((q) => <ToggleGroupItem key={q} value={q} variant="cards"><strong className="block text-sm font-medium">{QUALITY[q][0]}</strong><span className="block text-xs text-muted">{QUALITY[q][1]}</span></ToggleGroupItem>)}
          </ToggleGroup>
        </section>

        <section id="servicios" className="settings-card">
          <header><h2>{t("Services")}</h2><p>{desktop ? t("API keys are stored securely on this device.") : t("The server reads API keys from .env.local at startup.")}</p></header>
          <ul className="settings-services">
            {services.map((s) => <li key={s.id}><span className={`settings-status ${s.ready ? "is-ready" : ""}`} aria-hidden /><div><strong>{s.label}</strong><span>{s.detail}</span></div><em>{s.ready ? t("Connected") : t("No key")}</em></li>)}
          </ul>
          {desktop && <Button variant="outline" size="sm" onClick={async () => { try { const { invoke } = await import("@tauri-apps/api/core"); await invoke("open_settings"); } catch { setMessage({ ok: false, text: t("Could not open key settings.") }); } }}>{t("Manage keys")}</Button>}
          <p className="settings-note">{t("Your projects are stored in")} <code>{storage}</code>.</p>
        </section>
      </div>
      <div className="settings-savebar" data-visible={dirty || !!message || undefined} role="status">
        <span>{message ? message.text : t("You have unsaved changes.")}</span>
        {dirty && <><Button variant="ghost" size="sm" disabled={pending} onClick={() => { setDraft(JSON.parse(saved)); setMessage(null); }}>{t("Discard")}</Button><Button variant="primary" size="sm" disabled={pending} onClick={save}>{pending ? t("Saving…") : t("Save changes")}</Button></>}
      </div>
    </main>
  );
}

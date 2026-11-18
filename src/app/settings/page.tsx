import { t } from "@/lib/i18n";
import { io } from "next/cache";
import { Suspense } from "react";
import { getAppSettings } from "@/lib/app-settings";
import { allProviderStatuses, publicStatus } from "@/lib/agent/cli";
import { env, ttsProviderId } from "@/lib/env";
import { storageRoot } from "@/lib/storage";
import { AppNav } from "../app-nav";
import { SettingsForm, type ServiceStatus } from "./settings-form";
import "../home.css";
import "./settings.css";

export async function generateMetadata() {
  await io();
  return { title: `${t("Settings")} · VideoGen` };
}

export default function SettingsPage() {
  return (
    <div className="home">
      <AppNav current="settings" />
      <Suspense fallback={<p className="settings-loading">{t("Charging adjustments…")}</p>}>
        <SettingsLoader />
      </Suspense>
    </div>
  );
}

async function SettingsLoader() {
  await io();
  const e = env();
  const provider = ttsProviderId();
  const services: ServiceStatus[] = [
    // With Claude Code or Codex running the agent, the key is only needed for writing scripts.
    { id: "anthropic", label: getAppSettings().agentProvider === "anthropic" ? t("Agent and scripts") : t("Scripts"), detail: `Anthropic · ${e.ANTHROPIC_MODEL}`, ready: !!e.ANTHROPIC_API_KEY },
    { id: "tts", label: "Voces IA", detail: provider === "fishaudio" ? "Fish Audio" : "ElevenLabs", ready: !!(provider === "fishaudio" ? e.FISH_AUDIO_API_KEY : e.ELEVENLABS_API_KEY) },
    { id: "pixabay", label: t("Video and stock images"), detail: "Pixabay", ready: !!e.PIXABAY_API_KEY },
  ];
  const providers = (await allProviderStatuses()).map(publicStatus);
  return <SettingsForm initial={getAppSettings()} services={services} providers={providers} storage={storageRoot()} />;
}

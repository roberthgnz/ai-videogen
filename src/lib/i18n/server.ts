import fs from "node:fs";
import path from "node:path";
import { storageRoot } from "../storage";
import { languagePreference, resolveLocale, type LanguagePreference } from "./locale";

const systemLocale = process.env.VIDEOGEN_SYSTEM_LANGUAGE ?? new Intl.DateTimeFormat().resolvedOptions().locale;
const state = globalThis as typeof globalThis & { videoGenLanguagePreference?: LanguagePreference };

export function getLocale() {
  if (state.videoGenLanguagePreference === undefined) {
    try {
      const settings = JSON.parse(fs.readFileSync(path.join(storageRoot(), "settings.json"), "utf8"));
      state.videoGenLanguagePreference = languagePreference(settings?.language);
    } catch {
      state.videoGenLanguagePreference = "system";
    }
  }
  return resolveLocale(state.videoGenLanguagePreference, systemLocale);
}

export function setLanguagePreference(preference: LanguagePreference) {
  state.videoGenLanguagePreference = preference;
}

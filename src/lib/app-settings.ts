import fs from "node:fs";
import path from "node:path";
import { storageRoot } from "./storage";
import { appSettingsSchema, type AppSettings } from "./app-settings-shared";
import { setLanguagePreference } from "./i18n/server";

export * from "./app-settings-shared";

/**
 * Settings that apply to the whole app rather than one project: how much the agent may do on its own and
 * what a new project starts with. Kept as a small JSON file next to the database, so they survive updates
 * and need no migration.
 */

const file = () => path.join(storageRoot(), "settings.json");

/** The saved settings, with defaults for anything missing or unreadable. */
export function getAppSettings(): AppSettings {
  let raw: unknown = {};
  try { raw = JSON.parse(fs.readFileSync(file(), "utf8")); } catch { /* first run, or a hand-broken file: defaults */ }
  const parsed = appSettingsSchema.safeParse(raw);
  return parsed.success ? parsed.data : appSettingsSchema.parse({});
}

export function saveAppSettings(input: unknown): { ok: true; settings: AppSettings } | { ok: false; error: string } {
  const parsed = appSettingsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  fs.mkdirSync(storageRoot(), { recursive: true });
  // Write then rename: a crash mid-write never leaves half a file.
  const tmp = `${file()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(parsed.data, null, 2));
  fs.renameSync(tmp, file());
  setLanguagePreference(parsed.data.language);
  return { ok: true, settings: parsed.data };
}

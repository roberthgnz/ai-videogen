export const LANGUAGE_PREFERENCES = ["system", "en", "es"] as const;
export type LanguagePreference = (typeof LANGUAGE_PREFERENCES)[number];
export type Locale = Exclude<LanguagePreference, "system">;

export function languagePreference(value: unknown): LanguagePreference {
  return value === "es" || value === "en" ? value : "system";
}

export function resolveLocale(preference: LanguagePreference, systemLocale: string): Locale {
  if (preference !== "system") return preference;
  return systemLocale.toLowerCase().split(/[-_]/, 1)[0] === "es" ? "es" : "en";
}

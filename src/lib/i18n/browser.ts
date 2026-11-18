import { languagePreference, resolveLocale } from "./locale";

export function getLocale() {
  return resolveLocale(languagePreference(document.documentElement.lang), navigator.language);
}

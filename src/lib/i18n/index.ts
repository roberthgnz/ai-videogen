import { getLocale } from "#videogen-locale";
import spanish from "./es.json";
import type { Locale } from "./locale";

export { getLocale };

export function languageName(): "English" | "Spanish" {
  return getLocale() === "es" ? "Spanish" : "English";
}

const messages: Readonly<Record<string, string>> = spanish;

export function t(english: string, ...values: unknown[]): string {
  return localize(getLocale(), english, values);
}

function localize(locale: Locale, english: string, values: unknown[]): string {
  const message = locale === "es" && Object.hasOwn(messages, english) ? messages[english] : english;
  return message.replace(/\{(\d+)\}/g, (placeholder, index: string) =>
    Number(index) < values.length ? String(values[Number(index)]) : placeholder);
}

/** Immutable label tables can be declared at module scope and read after a language change. */
export function localizedLabels<T extends object>(makeLabels: (message: typeof t) => T): T {
  const english = makeLabels((message, ...values) => localize("en", message, values));
  let spanishLabels: T | undefined;
  return new Proxy(english, {
    get(_target, key) {
      if (getLocale() === "en") return Reflect.get(english, key);
      spanishLabels ??= makeLabels((message, ...values) => localize("es", message, values));
      return Reflect.get(spanishLabels, key);
    },
  });
}

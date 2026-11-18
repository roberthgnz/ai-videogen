import { t as translate } from "@/lib/i18n";
/** Escapes text for HTML element content and attribute values. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** JSON safe to embed inside a <script> (no `</script>` breakouts). */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replaceAll(String.fromCharCode(0x2028), "\\u2028")
    .replaceAll(String.fromCharCode(0x2029), "\\u2029");
}

export type TemplateVars = Record<string, string | number>;

/**
 * Tiny placeholder engine for the template files:
 * `{{name}}` is HTML-escaped, `{{{name}}}` is inserted raw (pre-built HTML or JSON).
 * Unknown placeholders throw, so a typo never ships an empty slot.
 */
export function fillTemplate(source: string, vars: TemplateVars): string {
  return source.replace(/\{\{\{\s*([\w.-]+)\s*\}\}\}|\{\{\s*([\w.-]+)\s*\}\}/g, (_, raw: string, escaped: string) => {
    const key = raw ?? escaped;
    if (!(key in vars)) throw new Error(translate("Template: the value \"{0} 'is missing.", key));
    const value = String(vars[key]);
    return raw ? value : escapeHtml(value);
  });
}

/** Small seeded PRNG (mulberry32) so every render of a scene is identical. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Seconds rounded to milliseconds, for readable attributes. */
export const sec = (n: number) => Math.round(n * 1000) / 1000;

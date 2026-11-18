import { t as translate } from "@/lib/i18n";
import { TEMPLATE_IDS, type TemplateId } from "@/lib/domain";
import { bulletsTemplate } from "./bullets";
import { introTemplate } from "./intro";
import { outroTemplate } from "./outro";
import { textTemplate } from "./text";
import type { SceneContent, TemplateDefinition } from "./types";

/**
 * Every template the app knows. Client-safe (zod only), so the editor UI,
 * the script generator and the composer all read the same definitions.
 * To add a template: create src/templates/<id>/, add its id to TEMPLATE_IDS
 * in src/lib/domain.ts and register it here (TypeScript enforces both).
 */
export const TEMPLATES = {
  intro: introTemplate,
  text: textTemplate,
  bullets: bulletsTemplate,
  outro: outroTemplate,
} satisfies Record<TemplateId, TemplateDefinition>;

export const templateList: TemplateDefinition[] = TEMPLATE_IDS.map((id) => TEMPLATES[id]);

export function getTemplate(id: TemplateId): TemplateDefinition {
  return TEMPLATES[id];
}

export function emptyContent(id: TemplateId): SceneContent {
  const content: SceneContent = {};
  for (const field of getTemplate(id).fields) {
    content[field.key] = field.kind === "list" ? Array(field.minItems).fill("") : "";
  }
  return content;
}

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.filter((v) => typeof v === "string" && v).join(" · ");
  return "";
}

/**
 * Carries content across a template switch by field role:
 * primary -> primary, secondary -> secondary, list -> list.
 * Missing roles fall back sensibly (list items joined into text, text split into items).
 */
export function convertContent(
  fromId: TemplateId,
  content: SceneContent,
  toId: TemplateId,
): SceneContent {
  const from = getTemplate(fromId);
  const byRole = (role: string) => from.fields.find((f) => f.role === role);
  const primary = textOf(content[byRole("primary")?.key ?? ""]);
  const secondary = textOf(content[byRole("secondary")?.key ?? ""]);
  const listField = byRole("list");
  const list = listField && Array.isArray(content[listField.key]) ? (content[listField.key] as string[]) : [];

  const out = emptyContent(toId);
  for (const field of getTemplate(toId).fields) {
    if (field.kind === "list") {
      const items = list.length > 0 ? list : secondary ? [secondary] : [];
      const padded = [...items];
      while (padded.length < field.minItems) padded.push("");
      out[field.key] = padded.slice(0, field.maxItems).map((s) => s.slice(0, field.maxLength));
    } else {
      const value = field.role === "primary" ? primary : secondary || (list.length ? textOf(list) : "");
      out[field.key] = value.slice(0, field.maxLength);
    }
  }
  return out;
}

/** Validates content against its template. Returns readable issues (Spanish) or []. */
export function contentIssues(id: TemplateId, content: unknown): string[] {
  const template = getTemplate(id);
  const result = template.schema.safeParse(content);
  if (result.success) return [];
  return result.error.issues.map((issue) => {
    const field = template.fields.find((f) => f.key === issue.path[0]);
    const where = field ? field.label : String(issue.path.join("."));
    const index = typeof issue.path[1] === "number" ? ` ${issue.path[1] + 1}` : "";
    return `${where}${index}: ${describeIssue(issue)}`;
  });
}

function describeIssue(issue: { code: string; message: string; minimum?: unknown; maximum?: unknown; origin?: unknown }): string {
  if (issue.code === "too_small") {
    return issue.origin === "array" ? translate("minimum {0} elements", issue.minimum) : translate("can't be empty");
  }
  if (issue.code === "too_big") {
    return issue.origin === "array" ? translate("maximum {0} elements", issue.maximum) : translate("maximum {0} characters", issue.maximum);
  }
  return issue.message;
}

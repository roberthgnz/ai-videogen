import type { z } from "zod";
import type { TemplateId } from "@/lib/domain";

/**
 * How a content field is edited in the UI and described to the LLM.
 * `role` lets content survive a template switch (primary -> primary, ...).
 */
export type FieldSpec =
  | {
      key: string;
      kind: "text";
      label: string;
      maxLength: number;
      required: boolean;
      role: "primary" | "secondary";
      /** Hint for the LLM about what goes in the field. */
      hint: string;
    }
  | {
      key: string;
      kind: "list";
      label: string;
      maxLength: number;
      minItems: number;
      maxItems: number;
      role: "list";
      hint: string;
    };

export type { SceneContent } from "@/lib/domain";

export interface TemplateDefinition<Schema extends z.ZodObject = z.ZodObject> {
  id: TemplateId;
  /** UI name (Spanish). */
  label: string;
  /** When to use it; goes into the LLM system prompt. */
  description: string;
  /** Validates the on-screen content of a scene using this template. */
  schema: Schema;
  fields: FieldSpec[];
}

export function defineTemplate<Schema extends z.ZodObject>(
  def: TemplateDefinition<Schema>,
): TemplateDefinition<Schema> {
  return def;
}

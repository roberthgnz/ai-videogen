import { z } from "zod";
import { defineTemplate } from "../types";

export const outroContentSchema = z.object({
  headline: z.string().max(60),
  cta: z.string().max(60),
});

export type OutroContent = z.infer<typeof outroContentSchema>;

export const outroTemplate = defineTemplate({
  id: "outro",
  label: "Outro",
  description: "Close the video: a call to action on a button and, optionally, a final sentence. Always the last scene.",
  schema: outroContentSchema,
  fields: [
    {
      key: "headline",
      kind: "text",
      label: "Cierre",
      maxLength: 60,
      required: false,
      role: "primary",
      hint: "normally \";\" only a conclusion of 2-5 words that does not repeat the narrative",
    },
    {
      key: "cta",
      kind: "text",
      label: "Call to action",
      maxLength: 60,
      required: false,
      role: "secondary",
      hint: "2-4 words, e.g. \"Follow me for more\"; \"\" if not applied",
    },
  ],
});

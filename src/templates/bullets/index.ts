import { z } from "zod";
import { defineTemplate } from "../types";

export const bulletsContentSchema = z.object({
  heading: z.string().max(60),
  items: z.array(z.string().min(1).max(50)).max(5),
});

export type BulletsContent = z.infer<typeof bulletsContentSchema>;

export const bulletsTemplate = defineTemplate({
  id: "bullets",
  label: "List of points",
  description:
    "Enumeration: from 2 to 5 very short points that appear one by one on the video when the voice mentions them, in the same order. Only when the narration lists real steps, causes or examples.",
  schema: bulletsContentSchema,
  fields: [
    {
      key: "heading",
      kind: "text",
      label: "Encabezado",
      maxLength: 60,
      required: false,
      role: "primary",
      hint: "what is listed, in 1-4 words; \"if it is understood without him,",
    },
    {
      key: "items",
      kind: "list",
      label: "Puntos",
      maxLength: 50,
      minItems: 0,
      maxItems: 5,
      role: "list",
      hint: "each point in 1-4 keywords (not phrases), in the order in which the narrative tells them",
    },
  ],
});

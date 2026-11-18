import { z } from "zod";
import { defineTemplate } from "../types";

export const textContentSchema = z.object({
  headline: z.string().max(60),
  body: z.string().max(140),
});

export type TextContent = z.infer<typeof textContentSchema>;

export const textTemplate = defineTemplate({
  id: "text",
  label: "Video with key data",
  description:
    "Development scene: the background video and subtitles bear the weight. Optionally it highlights in large A data that should be seen written (a figure, a name, a date) with a short label. Without data, it leaves the two fields empty.",
  schema: textContentSchema,
  fields: [
    {
      key: "headline",
      kind: "text",
      label: "Dato",
      maxLength: 60,
      required: false,
      role: "primary",
      hint: "the data as read, as short as possible (\"3.5%,\" \"1969,\" \"25 to 150 Hz\"); \"\" if the scene does not have a key data",
    },
    {
      key: "body",
      kind: "text",
      label: "Etiqueta",
      maxLength: 140,
      required: false,
      role: "secondary",
      hint: "what is that data, in 2-5 words; \"\" if there is no data",
    },
  ],
});

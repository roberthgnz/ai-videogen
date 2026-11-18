import { z } from "zod";
import { defineTemplate } from "../types";

export const introContentSchema = z.object({
  title: z.string().max(60),
  subtitle: z.string().max(90),
});

export type IntroContent = z.infer<typeof introContentSchema>;

export const introTemplate = defineTemplate({
  id: "intro",
  label: "Intro con gancho",
  description:
    "Video opening. The hook written as a large sign on the background video, with an optional support line. Always the first scene.",
  schema: introContentSchema,
  fields: [
    {
      key: "title",
      kind: "text",
      label: "Gancho",
      maxLength: 60,
      required: false,
      role: "primary",
      hint: "the video hook in 2-6 words; it is the first thing to read",
    },
    {
      key: "subtitle",
      kind: "text",
      label: "Apoyo",
      maxLength: 90,
      required: false,
      role: "secondary",
      hint: "normally \";\" only if you add a data that the hook does not say",
    },
  ],
});

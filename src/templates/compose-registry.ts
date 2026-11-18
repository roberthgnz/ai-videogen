import fs from "node:fs";
import { appResource } from "@/lib/runtime";
import type { TemplateId } from "@/lib/domain";
import { composeBullets } from "./bullets/compose";
import type { SceneComposer } from "./compose-types";
import { composeIntro } from "./intro/compose";
import { composeOutro } from "./outro/compose";
import { composeText } from "./text/compose";

/** Server-side half of each template: its scene.html and the function that fills it. */
export const SCENE_COMPOSERS: Record<TemplateId, SceneComposer> = {
  intro: composeIntro,
  text: composeText,
  bullets: composeBullets,
  outro: composeOutro,
};

const cache = new Map<TemplateId, string>();

export function sceneHtmlSource(id: TemplateId): string {
  const hit = cache.get(id);
  if (hit && process.env.NODE_ENV === "production") return hit;
  const file = appResource("src", "templates", id, "scene.html");
  const source = fs.readFileSync(file, "utf8");
  cache.set(id, source);
  return source;
}

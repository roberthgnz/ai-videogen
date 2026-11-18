import { escapeHtml } from "@/lib/pipeline/composition/html";
import { sizeFor } from "@/lib/pipeline/composition/shared";
import type { SceneComposer } from "../compose-types";

export const composeIntro: SceneComposer = ({ prefix, content, layout }) => {
  const title = String(content.title ?? "").trim();
  return {
    // Empty title: no element at all, so the scene is just footage and captions.
    title: title ? `<h1 id="${prefix}-title" class="display"><span class="label-run">${escapeHtml(title)}</span></h1>` : "",
    titleSize: sizeFor(title, [[14, 104], [26, 88], [40, 74], [60, 62]], layout),
    subtitle: String(content.subtitle ?? "").trim(),
    subtitleSize: Math.round(46 * layout.scale),
  };
};

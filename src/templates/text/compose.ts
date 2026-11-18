import { sec } from "@/lib/pipeline/composition/html";
import { sizeFor } from "@/lib/pipeline/composition/shared";
import { bulletRevealTimes } from "../bullets/compose";
import type { SceneComposer } from "../compose-types";

export const composeText: SceneComposer = ({ content, layout, words, narrationStart, duration }) => {
  const headline = String(content.headline ?? "").trim();
  // The fact lands when the voice says it (or early in the scene if it is never said literally).
  const said = headline ? bulletRevealTimes([headline], words, narrationStart, duration)[0] : 0;
  return {
    headline,
    body: String(content.body ?? "").trim(),
    headlineSize: sizeFor(headline, [[7, 190], [12, 140], [20, 104], [34, 80], [60, 62]], layout),
    bodySize: Math.round(48 * layout.scale),
    revealAt: sec(Math.max(0.2, Math.min(said, Math.max(0.2, duration - 2.2)))),
  };
};

import { sizeFor } from "@/lib/pipeline/composition/shared";
import type { SceneComposer } from "../compose-types";

export const composeOutro: SceneComposer = ({ content, layout }) => {
  const headline = String(content.headline ?? "").trim();
  const cta = String(content.cta ?? "").trim();
  return {
    headline,
    cta,
    headlineSize: sizeFor(headline, [[16, 96], [28, 80], [44, 66], [60, 56]], layout),
    ctaSize: sizeFor(cta, [[18, 58], [30, 50], [60, 42]], layout),
  };
};

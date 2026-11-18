import { t as translate } from "@/lib/i18n";
import type { EditDocument, EditReference } from "@/lib/editing/schema";
import { blankProfile, type GraphicsDensity, type StyleColor, type StyleLogo, type StylePace, type StyleProfile } from "./schema";

/**
 * Turns what the agent observed in a project's references (each one's saved analysis) into a proposal of
 * «Mi estilo» that the user reviews and edits before anything is saved. Pure: the caller adds the logos it
 * finds in the global library.
 */

export interface ReferenceProposal {
  profile: StyleProfile;
  /** Titles of the references the proposal comes from. */
  studied: string[];
  /** Titles of style, brand or script references the agent has not studied yet (no analysis). */
  unstudied: string[];
  /** Brand references that are pictures: candidate logos (project asset ids). */
  logoAssets: { assetId: string; name: string; path: string }[];
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
/** Tenths of a second, without float noise (1.2, not 1.2000000000000002). */
const tenths = (n: number) => Math.round(n * 10) / 10;
const clipText = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);
/** «Ref A: …» lines, one per reference, within a field's limit. */
const joined = (items: { title: string; text: string }[], max: number) =>
  clipText(items.filter((i) => i.text.trim()).map((i) => (items.length > 1 ? `${i.title}: ${i.text.trim()}` : i.text.trim())).join("\n"), max);

function paceFor(seconds: number): StylePace {
  return seconds < 1.5 ? "fast" : seconds < 3.5 ? "medium" : "calm";
}

/** Hex colours written in a text (a brand guide), in order and without repeats. */
function hexColors(text: string): string[] {
  return [...new Set([...text.matchAll(/#[0-9a-fA-F]{6}\b/g)].map((m) => m[0].toLowerCase()))];
}

export function profileFromReferences(doc: Pick<EditDocument, "references" | "assets">, id: string, name: string, now: number): ReferenceProposal {
  const guides = doc.references.filter((r) => r.roles.some((role) => role === "style" || role === "brand" || role === "script"));
  const analyzed = guides.filter((r): r is EditReference & { analysis: NonNullable<EditReference["analysis"]> } => !!r.analysis);
  const style = analyzed.filter((r) => r.roles.includes("style"));
  const looks = style.length ? style : analyzed;
  const brand = doc.references.filter((r) => r.roles.includes("brand"));
  const profile = blankProfile(id, name, now);

  if (looks.length) {
    const shot = median(looks.map((r) => r.analysis.pacing.shotSeconds));
    profile.pacing = { pace: paceFor(shot), shotSeconds: Math.min(30, Math.max(0.2, tenths(shot))), notes: joined(looks.map((r) => ({ title: r.title, text: r.analysis.pacing.progression })), 800) };
    profile.look = joined(looks.map((r) => ({ title: r.title, text: r.analysis.visualStyle })), 1200);
    profile.sound = joined(looks.map((r) => ({ title: r.title, text: r.analysis.audio })), 800);

    // Subtitles: the most common text mode decides; their look comes from a reference that has them.
    const modes = looks.map((r) => r.analysis.text.mode);
    const withCaptions = looks.filter((r) => r.analysis.text.mode === "captions" || r.analysis.text.mode === "both");
    const source = (withCaptions[0] ?? looks[0]).analysis.text;
    const a = source.appearance;
    profile.captions = {
      ...profile.captions,
      use: withCaptions.length * 2 > looks.length ? "always" : withCaptions.length === 0 ? "never" : "auto",
      wordsPerCue: Math.round(median((withCaptions.length ? withCaptions : looks).map((r) => r.analysis.text.wordsPerCue))),
      y: Math.min(95, Math.max(0, Math.round(a.y))),
      fontSize: Math.round(a.fontSize),
      color: a.color.toLowerCase(),
      background: a.background === "transparent" ? "transparent" : a.background.toLowerCase(),
      notes: joined((withCaptions.length ? withCaptions : looks).map((r) => ({ title: r.title, text: r.analysis.text.treatment })), 600),
    };
    profile.fonts.text = { ...profile.fonts.text, family: a.fontFamily ?? "sans", weight: a.fontWeight ?? 700, italic: a.fontStyle === "italic" };
    const titled = looks.filter((r) => r.analysis.text.mode === "titles" || r.analysis.text.mode === "both");
    if (titled.length) {
      const t = titled[0].analysis.text.appearance;
      profile.fonts.titles = { ...profile.fonts.titles, family: t.fontFamily ?? "sans", weight: Math.max(t.fontWeight ?? 800, 700), italic: t.fontStyle === "italic" };
    }

    // Graphics: what the references put on screen besides subtitles.
    const count = (mode: string) => modes.filter((m) => m === mode).length;
    const density: GraphicsDensity = count("none") === modes.length ? "none" : titled.length * 2 > modes.length ? "some" : titled.length ? "few" : count("captions") ? "few" : "none";
    // Drawn pictures: how to redraw them, so the next videos get the same graphics and not stock footage.
    const drawn = looks.filter((r) => r.analysis.imagery && r.analysis.imagery.kind !== "footage");
    const recipe = joined(drawn.map((r) => ({ title: r.title, text: r.analysis.imagery!.recipe })), 520);
    profile.graphics = { ...profile.graphics, density, notes: recipe ? clipText(translate("Image with own graphics (create_graphic), not stock. {0}", recipe), 600) : profile.graphics.notes };
  }

  // Colours: those of the subtitles they show, then any written in a brand reference.
  const colors: StyleColor[] = [];
  const add = (hex: string, role: string) => { if (!colors.some((c) => c.hex === hex) && colors.length < 8) colors.push({ hex, role }); };
  if (looks.length) {
    add(profile.captions.color, translate("Text"));
    if (profile.captions.background !== "transparent") add(profile.captions.background, translate("Text fund"));
  }
  for (const r of [...brand, ...looks]) for (const hex of hexColors(`${r.content}\n${r.analysis?.visualStyle ?? ""}\n${r.analysis?.imagery?.recipe ?? ""}`)) add(hex, r.roles.includes("brand") ? "Marca" : "");
  profile.colors = colors;

  profile.brand = clipText(brand.map((r) => r.content.replace(/\s+/g, " ").trim()).filter(Boolean).join(" · "), 800);

  const logoAssets = brand.flatMap((r) => {
    const asset = r.assetId ? doc.assets.find((x) => x.id === r.assetId) : undefined;
    return asset?.kind === "image" ? [{ assetId: asset.id, name: asset.name, path: asset.path }] : [];
  });

  return {
    profile,
    studied: analyzed.map((r) => r.title),
    unstudied: guides.filter((r) => !r.analysis && (r.assetId || r.content.trim())).map((r) => r.title),
    logoAssets,
  };
}

/**
 * The proposal applied on top of an existing profile: what the references observed replaces what the profile
 * said about the same thing; colours and logos are added; the user's rules and name stay.
 */
export function mergeIntoProfile(base: StyleProfile, proposal: StyleProfile): StyleProfile {
  const colors = [...base.colors];
  for (const c of proposal.colors) if (!colors.some((x) => x.hex === c.hex) && colors.length < 8) colors.push(c);
  const logos: StyleLogo[] = [...base.logos];
  for (const l of proposal.logos) if (!logos.some((x) => x.assetId === l.assetId) && logos.length < 6) logos.push(l);
  return {
    ...base,
    brand: proposal.brand || base.brand,
    look: proposal.look || base.look,
    sound: proposal.sound || base.sound,
    colors,
    logos,
    fonts: proposal.pacing.pace ? proposal.fonts : base.fonts,
    pacing: proposal.pacing.pace ? proposal.pacing : base.pacing,
    captions: proposal.pacing.pace ? { ...proposal.captions, highlight: base.captions.highlight, uppercase: base.captions.uppercase } : base.captions,
    graphics: proposal.graphics.density ? { ...proposal.graphics, notes: base.graphics.notes || proposal.graphics.notes } : base.graphics,
    rules: [...base.rules, ...proposal.rules.filter((r) => !base.rules.some((x) => x.text.toLowerCase() === r.text.toLowerCase()))],
  };
}

import { t as translate, localizedLabels } from "@/lib/i18n";
import type { EditAsset, EditOverlay, EditReference, ReferenceRole } from "./schema";

/** How each role is named and explained in the editor. */
export const REFERENCE_ROLE_INFO: Record<ReferenceRole, { label: string; hint: string }> = localizedLabels((translate) => ({
  style: { label: translate("Visual style"), hint: translate("Rhythm, planes, transitions, colors and texts") },
  script: { label: translate("Script"), hint: translate("Structure, hook, tone and call to action") },
  brand: { label: "Marca", hint: translate("Colors, logo, name and tone of voice") },
  product: { label: "Producto", hint: translate("Real interface and functions, not invented") },
}));

/**
 * What a new file reference guides unless the user changes it: a video carries both an
 * edit and a script, an image a look, a document words, an audio its pace and mood.
 */
export function defaultReferenceRoles(kind: EditAsset["kind"]): ReferenceRole[] {
  if (kind === "video") return ["style", "script"];
  if (kind === "document") return ["script"];
  return ["style"];
}

/** A reference made from an uploaded file: named after it, with the default roles for its kind. */
export function fileReference(asset: EditAsset, id: string = crypto.randomUUID()): EditReference {
  return { id, title: (asset.name.replace(/\.[^.]+$/, "").trim() || translate("Reference")).slice(0, 160), roles: defaultReferenceRoles(asset.kind), content: "", url: "", assetId: asset.id };
}

/** Turns a role on or off; a reference always keeps at least one. */
export function toggleReferenceRole(reference: EditReference, role: ReferenceRole): EditReference {
  const has = reference.roles.includes(role);
  if (has && reference.roles.length === 1) return reference;
  const roles = has ? reference.roles.filter((r) => r !== role) : [...reference.roles, role];
  return { ...reference, roles: (Object.keys(REFERENCE_ROLE_INFO) as ReferenceRole[]).filter((r) => roles.includes(r)), analysis: undefined };
}

/** Whether the script of this reference can be read from its sound and has not been yet. */
export function needsTranscript(reference: EditReference, asset: EditAsset | undefined): boolean {
  return !!asset && reference.roles.includes("script") && !reference.content.trim() && (asset.kind === "audio" || (asset.kind === "video" && asset.hasAudio));
}

/** A transcription as the text of a reference: one timed line per caption, within the reference limit. */
export function transcriptText(captions: Pick<EditOverlay, "start" | "text">[]): string {
  const lines = captions.map((c) => `${c.start.toFixed(1)} s: ${c.text.replace(/\s+/g, " ").trim()}`).filter((l) => !l.endsWith(": "));
  return lines.length ? translate("Transcript:\n{0}", lines.join("\n")).slice(0, 16000) : "";
}

/** The message that asks the assistant to apply a reference, worded after what it guides. */
export function referencePrompt(reference: EditReference): string {
  const parts: string[] = [];
  if (reference.roles.includes("style")) parts.push(translate("imitates its visual style (cutting rhythm, transitions, colors and texts)"));
  if (reference.roles.includes("script")) parts.push(translate("follow the structure and tone of your script with your words"));
  if (reference.roles.includes("brand")) parts.push("respeta su marca (colores, logo y tono)");
  if (reference.roles.includes("product")) parts.push(translate("shows the product as it is, without inventing functions"));
  return translate("Use the reference \"{0}\" in my assembly: {1}. Tell me what you have taken from it.", reference.title, parts.join("; "));
}

import { localizedLabels, t as translate } from "@/lib/i18n";
/**
 * Editing in passes: the order a video is worked in and what the user approves. Shared by the server and
 * the studio (no Node APIs here). The state and the saved versions live in passes.ts.
 */

/**
 * In this order: each pass builds on the ones before it. Every one is optional: the plan of each video
 * (what the user asks for and what the material already has) says which of them it needs.
 */
export const EDIT_PASSES = ["cut", "captions", "graphics", "sound"] as const;
export type EditPass = (typeof EDIT_PASSES)[number];

/**
 * «Guiado»: after every pass the user watches the preview and approves it or asks for changes.
 * «Rápido»: the agent chains the passes and the user reviews everything at the end.
 */
export const PASS_MODES = ["guided", "fast"] as const;
export type PassMode = (typeof PASS_MODES)[number];

/**
 * pending: not started · working: the agent is on it · review: waiting for the user · approved: the user said
 * yes · skipped: this video does not need it (already cut, captions burnt in, nothing asked for…).
 */
export const PASS_STATUSES = ["pending", "working", "review", "approved", "skipped"] as const;
export type PassStatus = (typeof PASS_STATUSES)[number];

/**
 * approved: made by approving a pass · manual: saved by the user · agent: saved by the agent when asked ·
 * review: what a pass left when the agent finished it · backup: what there was before going back to a version.
 */
export const VERSION_KINDS = ["approved", "manual", "agent", "review", "backup"] as const;
export type VersionKind = (typeof VERSION_KINDS)[number];

export const PASS_INFO: Record<EditPass, {
  /** «Corte» */
  label: string;
  /** «el corte», to write sentences */
  the: string;
  /** Name of the version an approval creates. */
  approved: string;
  /** «Corte listo», «Subtítulos listos»: finished, waiting for the user. */
  ready: string;
  /** What the pass decides, for the user and the agent. */
  covers: string;
  /** Something the user could write to ask for changes. */
  example: string;
}> = localizedLabels((translate) => ({
  cut: {
    label: translate("Court"), the: translate("the cutting"), approved: translate("Court approved"), ready: translate("Cut ready"),
    covers: translate("what plans enter, what order and how long each one lasts"),
    example: translate("Remove the plane from the beginning and shorten the end to 3 seconds"),
  },
  captions: {
    label: translate("Subtitles"), the: translate("the subtitles"), approved: translate("Approved subtitles"), ready: translate("Subtitles ready"),
    covers: translate("the subtitles of what is said: text, times and style"),
    example: translate("Put the subtitles up and write \"Paris\" with tilde"),
  },
  graphics: {
    label: translate("Graphics"), the: translate("the graphs"), approved: translate("Approved graphs"), ready: translate("Graphics ready"),
    covers: translate("titles, signs, transitions and camera movements"),
    example: translate("Remove the zoom from the background and put the title in yellow"),
  },
  sound: {
    label: translate("Sound"), the: "el sonido", approved: "Sonido aprobado", ready: translate("Sound ready"),
    covers: translate("music, voiceover, and volume"),
    example: translate("Put the music down and get in after the hook"),
  },
}));

export const PASS_MODE_INFO: Record<PassMode, { label: string; hint: string }> = localizedLabels((translate) => ({
  guided: { label: "Guiado", hint: translate("The agent for after every pass: you see it and you approve it or ask for changes.") },
  fast: { label: translate("Quick"), hint: translate("The agent does all the steps in a row and you check everything in the end.") },
}));

export const PASS_STATUS_LABELS: Record<PassStatus, string> = localizedLabels((translate) => ({
  pending: translate("Pending"),
  working: translate("In progress"),
  review: translate("To review"),
  approved: "Aprobada",
  skipped: translate("No need"),
}));

export const VERSION_KIND_LABELS: Record<VersionKind, string> = localizedLabels((translate) => ({
  approved: "Aprobada",
  manual: "Guardada por ti",
  agent: translate("Stayed by the agent"),
  review: translate("To review"),
  backup: translate("Automatic copy"),
}));

export interface PassEntryView {
  pass: EditPass;
  status: PassStatus;
  /** What the agent said when it left the pass for review (what changed, what to look at), or why it is skipped. */
  note: string;
  updatedAt: string | null;
  /** The version its approval created. */
  versionId: string | null;
}

export interface VersionView {
  id: string;
  name: string;
  kind: VersionKind;
  pass: EditPass | null;
  createdAt: string;
  /** «8 clips · 12 textos · 24,5 s» */
  summary: string;
  /** It holds exactly the montage saved now: going back to it changes nothing. */
  current: boolean;
}

/** The passes and versions of one project, as the studio shows them. */
export interface PassesView {
  mode: PassMode;
  /** The passes this video needs were chosen (by the agent from the request, or by the user). */
  planned: boolean;
  /** All four, the skipped ones too (status «skipped»): the studio shows only the others. */
  passes: PassEntryView[];
  /** The first pass of the plan not approved yet; null once all of them are. */
  current: EditPass | null;
  /** The last pass of the approved run from the start (corte, then subtítulos…). */
  lastApproved: EditPass | null;
  /** Newest first. */
  versions: VersionView[];
  /** Anything happened yet: a pass touched or a version saved. */
  started: boolean;
}

/** The next pass after `pass` that this video needs. */
export const nextPass = (pass: EditPass, skipped: (p: EditPass) => boolean = () => false): EditPass | null =>
  EDIT_PASSES.slice(EDIT_PASSES.indexOf(pass) + 1).find((p) => !skipped(p)) ?? null;

/** «el corte, los subtítulos y el sonido» */
export function passList(passes: readonly EditPass[], key: "the" | "label" = "the"): string {
  const names = passes.map((p) => key === "label" ? PASS_INFO[p].label.toLowerCase() : PASS_INFO[p].the);
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} y ${names.at(-1)}` : names[0] ?? "";
}

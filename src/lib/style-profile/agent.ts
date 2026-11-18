import { t as translate } from "@/lib/i18n";
import { z } from "zod";
import type { AgentContext, AgentTool } from "@/lib/agent/tools";
import { getProject } from "@/lib/projects";
import { saveEditDocument } from "@/lib/editing/repository";
import type { EditOverlay } from "@/lib/editing/schema";
import { captionWordTimings, placeWords, setHighlight, splitCaptionByWords } from "@/lib/editing/transcript";
import { transcriptWords } from "@/lib/editing/transcript-store";
import { importGlobalAssetToProject } from "@/lib/global-assets";
import { describeProfile, type StyleProfile } from "./schema";
import { pendingProposals, projectStyleProfile, proposeRule } from "./store";

/**
 * How the agent meets «Mi estilo»: a block in the project's state every turn (the profile it must follow, the
 * rules waiting for the user's answer) and a few tools: read it, bring one of its logos into the project,
 * dress the subtitles in it, and propose a new rule. The agent can never write the profile itself.
 */

/** How the agent must weigh the profile against the request and the references. */
const STYLE_GUIDE = "Es la base de TODOS los vídeos de este usuario, aprobada por él: aplícala sin que te la pida (colores y fuentes en place_text, posición y aspecto de subtítulos con apply_style_to_captions, ritmo en build_edit, logos con use_style_logo, densidad de gráficos al decidir rótulos, y sus colores, fuentes y notas de gráficos en cada create_graphic). Prioridad: lo que pida el usuario en este proyecto > reglas de Mi estilo > referencias del proyecto para lo que el perfil no fija > tu criterio. Si una referencia choca con una regla, manda la regla. Lo que el perfil no menciona lo decides con el prompt y las referencias. Cuando la apliques, di en el message qué has tomado de Mi estilo.";

const LEARNING_GUIDE = "APRENDER: when the user fixes something that would be worth all of his videos (not only this: \"the subtitles below,\" \"without emojis,\" \"less graphics\"), apply it here and, in addition, propon to save it with propose_style_rule; never for a preference of a single video or for what you decide. Nothing comes into My style without the user accepting it: don't say it's already saved.";

/** The «Mi estilo» block of the project's state, sent with every turn. */
export function describeStyleForAgent(projectId: string): string {
  const profile = projectStyleProfile(projectId);
  const pending = pendingProposals(projectId);
  const lines: string[] = [];
  if (profile) {
    lines.push(translate("MY STYLE of the user: profile \"{0}\" (assigned to this project). {1}", profile.name, STYLE_GUIDE), describeProfile(profile));
  } else {
    lines.push(translate("MY STYLE: This project does not use any style profile (the user chooses it in References › My style)."));
  }
  lines.push(LEARNING_GUIDE);
  if (pending.length) lines.push(translate("Rule proposals waiting for user response (do not repeat them): {0}.", pending.map((p) => `«${p.text}»`).join("; ")));
  return lines.join("\n");
}

function tool<S extends z.ZodObject>(def: AgentTool<S>): AgentTool<S> {
  return def;
}

function assigned(ctx: AgentContext): StyleProfile {
  const profile = projectStyleProfile(ctx.projectId);
  if (!profile) throw new Error(translate("This project does not use any profile of My style. Tell the user to choose it or believe it in References › My style."));
  return profile;
}

const getStyleProfile = tool({
  name: "get_style_profile",
  description: "Read the \"My style\" profile used by this project: brand and tone, colors, sources, logos, mounting rhythm, subtitles, graphics, sound and user rules. The state of each shift already includes it; use it to read it whole before mounting or if you doubt a preference.",
  schema: z.object({}),
  label: () => translate("Read My Style"),
  run: (_input, ctx) => {
    const profile = projectStyleProfile(ctx.projectId);
    if (!profile) return translate("This project does not use any profile of My style. Decide with the prompt and references; if the user gives a preference for all your videos, propose it with propose_style_rule.");
    return translate("My style: \"{0}.\"\n{1}\n{2}", profile.name, describeProfile(profile), STYLE_GUIDE);
  },
});

const useStyleLogo = tool({
  name: "use_style_logo",
  description: "Bring to the project one of the logos of My style (from the global library) and return your project file id. Then place it with edit_workspace as a picture clip on a top track (track 1 or more, fit contain), where and when you say its placement; if you say nothing, at the end and without covering faces or subtitles.",
  schema: z.object({ assetId: z.string().describe("assetId of the logo, as it appears in My style") }),
  label: () => translate("Bring the logo of My style"),
  run: (input, ctx) => {
    const profile = assigned(ctx);
    const logo = profile.logos.find((l) => l.assetId === input.assetId);
    if (!logo) throw new Error(translate("This logo is not in \"{0}.\" Logos available: {1}.", profile.name, profile.logos.map((l) => `${l.name} [${l.assetId}]`).join(", ") || "ninguno"));
    const edit = importGlobalAssetToProject(ctx.projectId, logo.assetId);
    const asset = edit.assets.find((a) => a.path === logo.path);
    if (!asset) throw new Error(translate("You couldn't bring the logo to the project."));
    return translate("Logo \"{0}\" available in the project with assetId {1} ({2} × {3}). {4} Place it with edit_workspace on a top track.", logo.name, asset.id, asset.width, asset.height, logo.placement ? translate(" Placement requested: {0}.", logo.placement) : "");
  },
});

const applyStyleToCaptions = tool({
  name: "apply_style_to_captions",
  description: "Dress the subtitles with My style: position, size, colors, source, capital letters and keywords in the color of the profile. SplitWords divide them using the available word times; without reliable times it keeps the group and indicates it. Do not create subtitles or play titles, voice or video. For a local note use apply_edit_notes in its reach, not this global tool.",
  schema: z.object({ splitWords: z.boolean().default(true).describe("Departure long subtitles in profile word groups") }),
  label: () => translate("Apply My style to subtitles"),
  run: async (input, ctx) => {
    const profile = assigned(ctx);
    let p = getProject(ctx.projectId);
    if (!p) throw new Error(translate("The project no longer exists."));
    const revision = p.edit.revision;
    const initial = p;
    const timings = new Map<string, NonNullable<Awaited<ReturnType<typeof transcriptWords>>>>();
    if (input.splitWords) {
      for (const asset of initial.edit.assets.filter((a) => a.hasAudio && initial.edit.clips.some((c) => c.assetId === a.id))) {
        const words = await transcriptWords(initial.id, asset.id).catch(() => null);
        if (words) timings.set(asset.id, words);
      }
    }
    p = getProject(ctx.projectId);
    if (!p || p.edit.revision !== revision) throw new Error(translate("The assembly has changed as the times were read. Read it again before applying My style."));
    const c = profile.captions, f = profile.fonts.text;
    const captions = p.edit.overlays.filter((o) => o.kind === "caption");
    if (!captions.length) throw new Error(translate("The assembly has no subtitles. Believe them before with analyze_media (operation transcribe, addCaptions true)."));
    const styled = (o: EditOverlay): EditOverlay => ({
      ...o, x: 5, width: 90, align: "center", y: c.y, fontSize: c.fontSize, color: c.color, background: c.background,
      fontFamily: f.family, fontWeight: f.weight, fontStyle: f.italic ? "italic" : "normal",
      text: c.uppercase ? o.text.toLocaleUpperCase("es") : o.text,
    });
    const doc = p.edit;
    const placed = new Map([...timings].map(([id, words]) => [id, placeWords(doc, id, words)]));
    let unsplit = 0;
    const overlays = doc.overlays.flatMap((o) => {
      if (o.kind !== "caption") return [o];
      let pieces = [o];
      if (input.splitWords && o.text.trim().split(/\s+/).length > c.wordsPerCue) {
        const candidates = [...timings].flatMap(([id, words]) => {
          const spoken = captionWordTimings(doc, id, words, o, placed.get(id));
          return spoken.length ? [{ id, spoken }] : [];
        });
        if (candidates.length === 1) {
          const { id, spoken } = candidates[0];
          pieces = splitCaptionByWords({ ...o, transcriptSource: { assetId: id, words: spoken.map((w) => w.index) } }, spoken, c.wordsPerCue);
        }
        if (pieces.length === 1) unsplit++;
      }
      return pieces.map(styled);
    });
    const currentHighlight = doc.transcript?.highlight;
    // A profile without a keyword colour says nothing about it: a highlight set for this project stays.
    const highlight = c.highlight ? { color: c.highlight, ...(currentHighlight?.words ? { words: currentHighlight.words } : {}) } : currentHighlight ?? null;
    const next = setHighlight({ ...doc, enabled: true, overlays }, highlight);
    const saved = saveEditDocument(p.id, next);
    const after = saved.overlays.filter((o) => o.kind === "caption").length;
    return translate("My style applied to {0} subtitles {1}: and = {2}, {3} px, {4} over {5}. {6} {7} Check with review_edit that do not cover faces.", captions.length, after !== captions.length ? ` (ahora ${after})` : "", c.y, c.fontSize, c.color, c.background, c.highlight ? translate(" Keywords in {0}.", c.highlight) : highlight ? translate(" The profile does not set highlighted: the profile of the project ({0}) is maintained.", highlight.color) : translate(" No highlight."), unsplit ? translate(" They are preserved {0} long groups because there are no unambiguous times or enough space to divide them without altering the synchrony.", unsplit) : "");
  },
});

const proposeStyleRule = tool({
  name: "propose_style_rule",
  description: "The user is asked to keep in My style a rule learned from your correction, for all your videos. He does not save it: the user sees the proposal in the chat with \"Add to my style\" or \"Discard.\" Use it only when the user corrects or asks for something that would be worth any video of his; one for an idea, in a mandatory and concrete phrase.",
  schema: z.object({
    rule: z.string().trim().min(3).max(300).describe("The rule as it would be in the profile, e.g. \"Subtitles at the height of the chest, never on the face\""),
    reason: z.string().trim().max(300).default("").describe("Why would it be worth all your videos, in a phrase for the user"),
  }),
  label: () => translate("Propose a rule for My style"),
  run: (input, ctx) => {
    const proposal = proposeRule(ctx.projectId, input.rule, input.reason);
    const profile = projectStyleProfile(ctx.projectId);
    return translate("Unpending proposal: \"{0}.\" The user will see it in the chat and decide whether to add it to {1}. It is not yet saved: in your message say you propose it to him, not that it is already in his style.", proposal.text, profile ? `«${profile.name}»` : translate("a new style"));
  },
});

/** The studio's «Mi estilo» tools, listed with the rest in AGENT_TOOLS. */
export const STYLE_TOOLS = [getStyleProfile, useStyleLogo, applyStyleToCaptions, proposeStyleRule] as unknown as AgentTool[];

import { t as translate } from "@/lib/i18n";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { FORMAT_SIZE } from "@/lib/domain";
import { MAX_COMPOSITION_SECONDS, readCompositionRoot, renderComposition } from "@/lib/editing/compositions";
import { filmstrip, seedFootage } from "@/lib/editing/footage";
import { discardGraphicFiles, graphicFrameTimes, isGraphic, placeGraphic } from "@/lib/editing/graphics";
import { warmOverview } from "@/lib/editing/overview";
import { saveEditDocument } from "@/lib/editing/repository";
import { deleteGlobalAsset, registerGlobalAsset } from "@/lib/global-assets";
import { getProject } from "@/lib/projects";
import { resolveInStorage, storagePaths } from "@/lib/storage";
import { AGENT_DIR } from "./cli/workspace";
import type { AgentTool } from "./tools";

/**
 * Whole HyperFrames compositions in the montage (see agent-skills/hyperframes-compositions): the agent
 * writes a HyperFrames project in its own folder with HyperFrames' skills and command line, and this tool
 * renders it and places it like a graphic of its own. Only the installed programs can use it: writing the
 * files takes their terminal and file tools.
 */

function tool<S extends z.ZodObject>(def: AgentTool<S>): AgentTool<S> {
  return def;
}

const assetId = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);

/** The composition's folder: inside the agent's own folder of this project, whatever links it goes through. */
async function compositionFolder(projectId: string, dir: string): Promise<{ absolute: string; relative: string }> {
  const project = path.resolve(storagePaths.project(projectId));
  const home = await fs.realpath(path.join(project, AGENT_DIR)).catch(() => path.join(project, AGENT_DIR));
  const real = await fs.realpath(path.resolve(project, dir)).catch(() => null);
  const inside = real ? path.relative(home, real) : "";
  if (!real || !inside || inside.startsWith("..") || path.isAbsolute(inside)) {
    throw new Error(translate("\"{0}\" is not a folder within {1} / of this project: it writes the composition in {2} / compositions / < name > / and passes that route.", dir, AGENT_DIR, AGENT_DIR));
  }
  if (!(await fs.stat(path.join(real, "index.html")).catch(() => null))?.isFile()) {
    throw new Error(translate("In \"{0}\" there is no index.html: the folder must be a HyperFrames project with its root composition.", dir));
  }
  return { absolute: real, relative: `${AGENT_DIR}/${inside.split(path.sep).join("/")}` };
}

const renderCompositionTool = tool({
  name: "render_composition",
  description:
    "Renderiza una COMPOSICIÓN DE HYPERFRAMES que has escrito como archivos en tu carpeta (agent/compositions/<name>/, con su index.html) y la deja como clip de vídeo del proyecto, igual que un gráfico de create_graphic. Es para lo que no cabe en un gráfico de un solo archivo: bloques y componentes del catálogo de HyperFrames (títulos animados, transiciones, gráficas, mapas, tarjetas, fondos, 3D), varias escenas, Lottie, three.js, canvas o shaders. Carga antes la skill hyperframes-compositions y comprueba la composición (check y snapshot) antes de llamar. La raíz debe medir lo que el formato del proyecto (1080×1920 en vertical, 1920×1080 en horizontal) y durar lo que el tramo que va a ocupar. El clip entra SIN sonido: la voz, la música y los efectos se ponen con las herramientas del estudio. Colocación como en create_graphic: replaceClipId cambia la imagen de ese clip; start la pone en ese segundo de la pista recortando lo que tape; sin ninguno queda en Archivos. Para corregirla, edita sus archivos y llama otra vez con replaces=<assetId anterior>. Devuelve fotogramas del resultado: míralos antes de responder.",
  schema: z.object({
    dir: z.string().trim().min(1).max(400).describe("HyperFrames project folder, related to the project folder: \"agent / compostions / leader.\""),
    name: z.string().trim().min(2).max(80).describe("Short name, as the file user will see: \"Head,\" \"Sales Graphic\""),
    description: z.string().trim().min(5).max(400).describe("What shows and what counts, in a sentence; it remains in the material register"),
    replaces: assetId.optional().describe("assetId of the previous version of ESTA composition (or of the graph that replaces): your clips go on to show the new and the previous one is removed"),
    replaceClipId: assetId.optional().describe("Go from a mounting image clip whose image becomes this composition"),
    start: z.number().min(0).max(7200).optional().describe("Second of the assembly where it starts; what covers on your track is cut"),
    track: z.number().int().min(0).max(49).optional().describe("Video track for start (0 = main; higher = above)"),
  }),
  label: (i) => translate("{0} the composition \"{1}\"", i.replaces ? translate("Renderize") : translate("Renderize"), i.name),
  run: async (input, ctx) => {
    const p = getProject(ctx.projectId);
    if (!p) throw new Error(translate("The project no longer exists."));
    if (input.replaceClipId && input.start !== undefined) throw new Error(translate("Use refuseClipId or start, not both."));
    const kindOf = (id: string) => p.edit.assets.find((a) => a.id === id)?.kind;
    const target = input.replaceClipId ? p.edit.clips.find((c) => c.id === input.replaceClipId) : undefined;
    if (input.replaceClipId && (!target || (kindOf(target.assetId) !== "video" && kindOf(target.assetId) !== "image"))) {
      throw new Error(translate("remplaceClipId is not a video or image clip of the current assembly: look at the ids in state Clips."));
    }
    const previous = input.replaces ? p.edit.assets.find((a) => a.id === input.replaces) : undefined;
    if (input.replaces && (!previous || !isGraphic(previous))) throw new Error(translate("replaces must be the assetId of a graph or an earlier composition that is still in the project."));

    // What the files declare, before a render that takes a while.
    const folder = await compositionFolder(p.id, input.dir);
    const root = readCompositionRoot(await fs.readFile(path.join(folder.absolute, "index.html"), "utf8"));
    const { width, height } = FORMAT_SIZE[p.format];
    if (root.width && root.height && (root.width !== width || root.height !== height)) {
      throw new Error(translate("The root of the composition measures {0} × {1} and the project is {2} ({3} × {4}): pon data-width = \"{5}\" and data-height = \"{6}\" at the root and adjusts the design to that canvas.", root.width, root.height, p.format, width, height, width, height));
    }
    if (root.duration && root.duration > MAX_COMPOSITION_SECONDS) {
      throw new Error(translate("The hard composition {0} s and the maximum by composition is {1} s: divela in several and bring them one by one.", root.duration.toFixed(1), MAX_COMPOSITION_SECONDS));
    }
    const tooShort = (seconds: number) => translate("The clip lasts {0} s and the composition {1} s: length data-duration of the root (and hold the last state) until it is covered.", target!.duration.toFixed(2), seconds.toFixed(2));
    if (target && root.duration && root.duration < target.duration - 0.05) throw new Error(tooShort(root.duration));
    if (input.start !== undefined && input.start + (root.duration ?? 0) > 7200) throw new Error(translate("The composition would end after the two hours that the assembly supports."));

    const asset = await renderComposition(p.id, { name: input.name, description: input.description, dir: folder.absolute, folder: folder.relative }, ctx.signal);
    const duration = Math.min(asset.duration, root.duration ?? asset.duration);

    // The montage as it is after the (slow) render: another tool of this turn may have saved meanwhile.
    let placed: string[];
    try {
      if (target && asset.duration < target.duration - 0.05) throw new Error(tooShort(asset.duration));
      const fresh = getProject(ctx.projectId);
      if (!fresh) throw new Error(translate("The project no longer exists."));
      const result = placeGraphic(fresh.edit, asset, { replaceClipId: input.replaceClipId, start: input.start, duration, track: input.track, replaces: input.replaces });
      saveEditDocument(fresh.id, result.doc, true);
      placed = result.placed;
    } catch (error) {
      await discardGraphicFiles(p.id, asset.id);
      throw error;
    }
    try {
      registerGlobalAsset({ id: asset.id, name: asset.name, kind: "video", source: "generated", path: asset.path, duration: asset.duration, width: asset.width, height: asset.height, hasAudio: false, context: asset.context, projectId: p.id });
    } catch { /* The library entry is a convenience: the clip is already in the project. */ }
    if (previous) {
      await deleteGlobalAsset(previous.id).catch(() => false);
      await discardGraphicFiles(p.id, previous.id);
    }
    await seedFootage(p.id, asset, translate("What HyperFrames contains: {0}", input.description)).catch(() => undefined);
    warmOverview(p.id, asset);

    const vertical = p.format === "vertical";
    // A longer piece has more moments worth a look.
    const times = graphicFrameTimes(duration, duration > 12 ? 9 : 6);
    const sheet = await filmstrip(times.map((t) => ({ file: resolveInStorage(asset.path), t })), { vertical, cols: 3, cellWidth: vertical ? 360 : 480 });
    if (sheet) ctx.images = [...(ctx.images ?? []), sheet];
    return [
      // One line: the chat shows a button's result by its first line.
      translate("\"{0} 'composition rendered: assetId {1}, {2} s {3} × {4}, without sound {5}.", input.name, asset.id, asset.duration.toFixed(2), width, height, placed.length ? `; ${placed.join("; ")}` : translate("; is in Files, not placed in the timeline (use start or replace ClipId, or edit_workspace)")),
      translate("Its source is still in {0} /: do not reuse that folder for another composition.", folder.relative),
      sheet
        ? `La imagen adjunta son ${times.length} fotogramas en t = ${times.join(", ")} s (de izquierda a derecha y de arriba abajo; el último es el estado final). Míralos como un director de arte: ¿se lee cada texto de un vistazo y dentro de la zona segura? ¿Encaja con la referencia, con Mi estilo y con los planos de alrededor (paleta, tipografía, aire)? ¿Entra cada pieza cuando toca y el final se sostiene? ¿Algo se corta, se pisa, queda vacío o sin estilo (un bloque mal montado se ve diminuto o sin diseño)?`
        : translate("No frames could be removed to review it: say it in your message instead of giving the result as checked."),
      translate("If something does not fit, edit the {0} / files and call again render_composition with replaces = \"{1}\" (maximum two laps).", folder.relative, asset.id),
    ].join("\n");
  },
});

/** The studio's composition tools, listed with the rest in AGENT_TOOLS. */
export const COMPOSITION_TOOLS = [renderCompositionTool] as unknown as AgentTool[];

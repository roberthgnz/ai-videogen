import { t as translate } from "@/lib/i18n";
import { z } from "zod";
import { FORMAT_SIZE } from "@/lib/domain";
import { filmstrip, seedFootage } from "@/lib/editing/footage";
import { discardGraphicFiles, graphicFrameTimes, graphicImageIds, isGraphic, placeGraphic, readGraphicSource, renderGraphic } from "@/lib/editing/graphics";
import { warmOverview } from "@/lib/editing/overview";
import { saveEditDocument } from "@/lib/editing/repository";
import { referenceAssetIds } from "@/lib/editing/schema";
import { deleteGlobalAsset, registerGlobalAsset } from "@/lib/global-assets";
import { getProject } from "@/lib/projects";
import { resolveInStorage } from "@/lib/storage";
import type { AgentTool } from "./tools";

/**
 * The agent's own pictures (see agent-skills/custom-graphics): it writes a graphic as markup, style sheet
 * and animation, the studio renders it into a clip and shows it frames of the result, so it draws what a
 * graphic reference asks for instead of covering it with stock footage.
 */

function tool<S extends z.ZodObject>(def: AgentTool<S>): AgentTool<S> {
  return def;
}

const assetId = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
/** Length of a graphic nobody gave a length to. */
const DEFAULT_SECONDS = 4;

const createGraphic = tool({
  name: "create_graphic",
  description:
    "Crea un GRÁFICO PROPIO a pantalla completa y lo deja como clip de vídeo del proyecto. Tú escribes el dibujo (html), su hoja de estilo (css) y su animación (animation: JavaScript sobre `tl`, una línea de tiempo de GSAP ya creada) y el estudio lo renderiza fotograma a fotograma al formato del proyecto. Es la herramienta para infografías, mapas, calendarios, comparativas, cifras, listas, collage de recortes y cualquier imagen que una referencia gráfica o Mi estilo pidan y que el stock no tiene: si la referencia es gráfica, NO la sustituyas por vídeo de stock. Carga antes la skill custom-graphics. Colocación: replaceClipId cambia la imagen de ese clip (el gráfico hereda su duración); start lo pone en ese segundo de la pista recortando lo que tape; sin ninguno queda en Archivos. Para corregirlo después de mirar sus fotogramas, llama otra vez con replaces=<assetId anterior>. styleFrom antepone el css de otro gráfico para que toda la serie sea un mismo sistema visual. Devuelve fotogramas del resultado: míralos y compáralos con la referencia antes de responder. Reglas: sin direcciones externas ni red; sin Math.random, Date, temporizadores, @keyframes ni transition (todo cuelga de tl; para azar usa rnd()).",
  schema: z.object({
    name: z.string().trim().min(2).max(80).describe("Short name of the graph, as the user will see in Files: \"Calendar 18 to 19,\" \"Comparative Map\""),
    description: z.string().trim().min(5).max(400).describe("What shows and what counts, in a sentence; it remains in the material register"),
    html: z.string().min(1).max(80000).describe("Drawing marking, within # stage (W × H px: 1080 × 1920 in vertical, 1920 × 1080 in horizontal). HTML and SVG in line; each piece that is encouraged with your id. Without < script >. To draw a project image (a photo or a user logo, never a reference): < img src = \"asset: < assetId >\" >, or url (asset: < asset >) in the css."),
    css: z.string().max(60000).default("").describe("Style sheet. Position in pixels of the canvas. Sources available by name: Inter, Montserrat, Outfit, Nunito, Oswald, League Gothic, Black File, Poppins, Roboto, Playfair Display, EB Garamond, Space Mono. Do not transform into CSS to an element that you encourage with GSAP."),
    animation: z.string().max(40000).default("").describe("Cuerpo de JavaScript. Dispone de tl (línea de tiempo en pausa, en segundos desde el inicio del gráfico), gsap, stage (el elemento #stage), W, H, D (duración), rnd() (azar reproducible, 0-1) y drawPath(selector, {duration, ease}, segundo), que hace que un <path>, <line> o <circle> de SVG se dibuje solo (rutas, tachados, flechas, subrayados). Usa tl.fromTo/tl.to/tl.set con su posición en segundos; para <canvas>, dibuja en un onUpdate de un tween de tl. No crees ni registres otra línea de tiempo raíz. Vacío = imagen fija."),
    duration: z.number().min(0.5).max(60).optional().describe("Seconds. With replaceClipId, by default the duration of that clip; if not, 4"),
    background: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().describe("Background colour of canvas; by default of assembly"),
    styleFrom: assetId.optional().describe("assetId of an earlier graph whose css previews that of this"),
    replaces: assetId.optional().describe("assetId of the previous version of this graphic: your clips are then displayed the new and the previous one is removed"),
    replaceClipId: assetId.optional().describe("Go from a mounting image clip (e.g. a stock plane) whose image becomes this graph"),
    start: z.number().min(0).max(7200).optional().describe("Second of the assembly where it starts; what covers on your track is cut"),
    track: z.number().int().min(0).max(49).optional().describe("Video track for start (0 = main; higher = above)"),
  }),
  label: (i) => translate("{0} the graph \"{1}\"", i.replaces ? "Corregir" : "Dibujar", i.name),
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
    if (input.replaces && (!previous || !isGraphic(previous))) throw new Error(translate("replaces must be the assetId of a graph created with create_graphic that is still in the project."));
    const style = input.styleFrom ? await readGraphicSource(p.id, input.styleFrom) : null;
    if (input.styleFrom && !style) throw new Error(translate("styleFrom is not a graph of this project with its saved style sheet."));
    const css = style ? `${style.css}\n${input.css}` : input.css;
    const guides = referenceAssetIds(p.edit);
    if (graphicImageIds({ html: input.html, css }).some((id) => guides.has(id))) throw new Error(translate("A reference guides the style, but it's not material: don't put it in the graph. You draw that style."));

    const earlier = previous ? await readGraphicSource(p.id, previous.id) : null;
    const duration = input.duration ?? target?.duration ?? (earlier?.duration || DEFAULT_SECONDS);
    if (target && duration < target.duration - 0.05) throw new Error(translate("The clip lasts {0} s and the graph {1} s: omits duration or uses at least that of the clip.", target.duration.toFixed(2), duration.toFixed(2)));
    if (input.start !== undefined && input.start + duration > 7200) throw new Error(translate("The graph would end after the two hours that the assembly supports."));

    const { asset, source } = await renderGraphic(p.id, {
      name: input.name, description: input.description, html: input.html, css,
      animation: input.animation, duration, background: input.background,
    }, ctx.signal);

    // The montage as it is after the (slow) render: another tool of this turn may have saved meanwhile.
    let placed: string[];
    try {
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
    } catch { /* The library entry is a convenience: the graphic is already in the project. */ }
    if (previous) {
      await deleteGlobalAsset(previous.id).catch(() => false);
      await discardGraphicFiles(p.id, previous.id);
    }
    await seedFootage(p.id, asset, translate("Own chart: {0}", source.description || source.name)).catch(() => undefined);
    warmOverview(p.id, asset);

    const vertical = p.format === "vertical";
    const times = graphicFrameTimes(Math.min(asset.duration, duration));
    const sheet = await filmstrip(times.map((t) => ({ file: resolveInStorage(asset.path), t })), { vertical, cols: 3, cellWidth: vertical ? 360 : 480 });
    if (sheet) ctx.images = [...(ctx.images ?? []), sheet];
    const { width, height } = FORMAT_SIZE[p.format];
    return [
      // One line: the chat shows a button's result by its first line.
      translate("Graph \"{0} 'renderized: assetId {1}, {2} s, {3} × {4} {5}.", source.name, asset.id, asset.duration.toFixed(2), width, height, placed.length ? `; ${placed.join("; ")}` : translate("; is in Files, not placed in the timeline (use start or replace ClipId, or edit_workspace)")),
      source.images.length ? translate("Project images used: {0}.", source.images.map((i) => `${i.assetId} → ${i.src}`).join(", ")) : "",
      sheet
        ? `La imagen adjunta son ${times.length} fotogramas en t = ${times.join(", ")} s (de izquierda a derecha y de arriba abajo; el último es el estado final). Míralos como un director de arte y compáralos con la referencia y con Mi estilo: paleta, fondo y texturas, formas y bordes, tipografía, composición y aire. ¿Se lee cada texto de un vistazo y dentro de la zona segura? ¿Entra cada pieza cuando toca y el final se sostiene? ¿Algo se corta, se pisa o queda vacío? Un cartel rojo «ANIMATION ERROR» significa que tu JavaScript falló: corrígelo.`
        : translate("No frames could be removed to review it: say it in your message instead of giving the style as proven."),
      translate("If something does not fit, run it again by calling create_graphic with replaces = \"{0}\" (maximum two turns). For the next graph of the series use styleFrom = \"{1}\" and send only the new css.", asset.id, asset.id),
    ].filter(Boolean).join("\n");
  },
});

const readGraphic = tool({
  name: "read_graphic",
  description: "Returns the html, css and animation with which a project's own graph was made. Use it before retouching a graph from a previous shift (\"change the rose to blue in the calendar\") or to follow its style in a new one; then call create_graphic with replaces or styleFrom.",
  schema: z.object({ assetId: assetId.describe("assetId of the graph (starting with graph-)") }),
  label: () => translate("Read how the graph is made"),
  run: async (input, ctx) => {
    const p = getProject(ctx.projectId);
    if (!p) throw new Error(translate("The project no longer exists."));
    const asset = p.edit.assets.find((a) => a.id === input.assetId);
    const source = asset ? await readGraphicSource(p.id, asset.id) : null;
    if (!asset || !source) {
      const made = p.edit.assets.filter(isGraphic);
      throw new Error(translate("That file is not a graph of this project. Graphics: {0}.", made.map((a) => `${a.name} [${a.id}]`).join(", ") || translate("None yet")));
    }
    const clips = p.edit.clips.filter((c) => c.assetId === asset.id).map((c) => translate("{0} ({1} - {2} s, track {3})", c.id, c.start.toFixed(2), (c.start + c.duration).toFixed(2), c.track ?? 0));
    return JSON.stringify({ assetId: asset.id, name: source.name, description: source.description, duration: source.duration, canvas: `${source.width}×${source.height}`, background: source.background,
      images: source.images, clips, html: source.html, css: source.css, animation: source.animation });
  },
});

/** The studio's own-graphics tools, listed with the rest in AGENT_TOOLS. */
export const GRAPHIC_TOOLS = [createGraphic, readGraphic] as unknown as AgentTool[];

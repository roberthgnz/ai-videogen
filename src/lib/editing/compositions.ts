import { t as translate } from "@/lib/i18n";
import fs from "node:fs/promises";
import path from "node:path";
import { FORMAT_SIZE } from "@/lib/domain";
import { probeMedia } from "@/lib/media/ffprobe";
import { runFfmpeg } from "@/lib/media/ffmpeg";
import { getRenderer } from "@/lib/pipeline/render";
import { getProject } from "@/lib/projects";
import { ensureDir, storagePaths, toStorageRelative } from "@/lib/storage";
import { GRAPHIC_PREFIX, inTurn } from "./graphics";
import type { EditAsset } from "./schema";

/**
 * A whole HyperFrames project as a clip. `create_graphic` covers a picture that fits in three texts; a
 * composition is everything else HyperFrames does (blocks and components from its registry, several scenes,
 * 3D, Lottie, shaders), written by the agent as files in its own folder with HyperFrames' own skills. The
 * studio renders that folder and takes the result in as one more graphic: same ids, same library entry,
 * same placement in the montage.
 */

/** Longest composition rendered in one go: a tool call has to answer within its time limit. */
export const MAX_COMPOSITION_SECONDS = 120;

export interface CompositionRoot {
  width?: number;
  height?: number;
  /** Seconds the root composition declares (`data-duration`). */
  duration?: number;
}

/** What the root composition of an `index.html` declares; a value it does not write as a plain number is left out. */
export function readCompositionRoot(html: string): CompositionRoot {
  const root = /<[a-z][^>]*\bdata-composition-id\s*=[^>]*>/i.exec(html)?.[0] ?? "";
  const number = (name: string) => {
    const value = Number(new RegExp(`\\b${name}\\s*=\\s*["']?([0-9]+(?:\\.[0-9]+)?)`, "i").exec(root)?.[1]);
    return Number.isFinite(value) && value > 0 ? value : undefined;
  };
  return { width: number("data-width"), height: number("data-height"), duration: number("data-duration") };
}

export interface CompositionInput {
  name: string;
  description: string;
  /** Absolute path of the HyperFrames project (the folder with `index.html`). */
  dir: string;
  /** The same folder as the agent names it, relative to the project: kept so the composition can be corrected later. */
  folder: string;
}

/**
 * Renders a composition into `media/<id>/media.mp4` of the project (silent, like every graphic) and notes
 * where its source is. Returns the file as a library entry; adding it to the montage is the caller's.
 */
export async function renderComposition(projectId: string, input: CompositionInput, signal?: AbortSignal): Promise<EditAsset> {
  const p = getProject(projectId);
  if (!p) throw new Error(translate("The project no longer exists."));
  const { width, height } = FORMAT_SIZE[p.format];
  const name = input.name.trim();
  const description = input.description.trim();

  const id = `${GRAPHIC_PREFIX}${crypto.randomUUID()}`;
  const dir = ensureDir(path.join(storagePaths.project(projectId), "media", id));
  const rendered = path.join(dir, "render.mp4");
  const file = path.join(dir, "media.mp4");
  try {
    await inTurn(() => getRenderer().render({ projectDir: input.dir, outFile: rendered, quality: "looks", signal }));
    // No sound track: the montage's voice, music and effects are the studio's, and a graphic is never transcribed.
    await runFfmpeg(["-v", "error", "-y", "-i", rendered, "-map", "0:v:0", "-an", "-c:v", "copy", "-movflags", "+faststart", file], signal);
    await fs.rm(rendered, { force: true });
    const info = await probeMedia(file);
    const stream = info.streams.find((s) => s.type === "video");
    if (!stream || info.durationSec <= 0) throw new Error(translate("The render of the composition does not contain video."));
    if (stream.width !== width || stream.height !== height) {
      throw new Error(translate("The composition has been renderated to {0}×{1} and the project is {2} ({3}×{4}): pon data-width = \"{5}\"and data-height =\"{6}\"at its root and adjust the design to that canvas.", stream.width, stream.height, p.format, width, height, width, height));
    }
    // The shape of a graphic's source, with no markup of its own: what it is made of is the folder.
    await fs.writeFile(path.join(dir, "source.json"), JSON.stringify({
      name,
      description: translate("{0} · HyperFrames composition: its source is in {1} / (edit those files and bring it back with render_composition and fill).", description, input.folder),
      composition: input.folder, html: "", css: "", animation: "",
      duration: info.durationSec, background: p.edit.background, width, height, images: [],
    }, null, 2));
    return {
      id, name: translate("Figure · {0}", name).slice(0, 240), kind: "video", path: toStorageRelative(file), duration: info.durationSec, width, height, hasAudio: false,
      context: translate("Composition of HyperFrames made by the wizard (source in {0} /): {1}", input.folder, description || name).slice(0, 16000),
    };
  } catch (error) {
    // Only the folder created above for this clip, inside this project's media.
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

import { t as translate } from "@/lib/i18n";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runFfmpeg } from "@/lib/media/ffmpeg";
import type { ProjectWithRelations } from "@/lib/projects";
import { filterPath, previewFont } from "./text-preview";

export interface BrollSheet {
  /** Base64 JPEG. */
  image: string;
  /** «escena.plano» of the shots whose picture could not be loaded (painted red on the sheet). */
  missing: string[];
}

/**
 * The b-roll picked for a script, as one picture: a row per scene, its shots left to right, each numbered
 * «escena.plano», separated by light gaps so a dark clip never reads as an empty cell. The b-roll tools return
 * it with what the voice says in each scene, so the agent checks every shot by eye (the sea is not «agua
 * hirviendo») instead of trusting the search words.
 */
export async function brollSheet(p: ProjectWithRelations): Promise<BrollSheet | null> {
  const tile = p.format === "horizontal" ? { w: 256, h: 144 } : { w: 144, h: 256 };
  const gap = 6;
  const rows = p.scenes.map((s) => (s.shots ?? []).map((shot) => shot.selected?.thumbUrl ?? ""));
  const cols = Math.max(0, ...rows.map((r) => r.length));
  if (!cols) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "videogen-broll-"));
  try {
    const cells: { r: number; c: number; file: string }[] = [];
    const missing: { r: number; c: number }[] = [];
    await Promise.all(rows.flatMap((row, r) => row.map(async (url, c) => {
      try {
        if (!/^https?:\/\//.test(url)) throw new Error(translate("Unthumbnails"));
        const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const file = path.join(dir, `${r}-${c}.jpg`);
        fs.writeFileSync(file, Buffer.from(await response.arrayBuffer()));
        cells.push({ r, c, file });
      } catch (error) {
        console.error("[broll-sheet] miniatura", url, error instanceof Error ? error.message : error);
        missing.push({ r, c });
      }
    })));
    if (!cells.length) return null;
    const font = previewFont();
    const x = (c: number) => gap + c * (tile.w + gap);
    const y = (r: number) => gap + r * (tile.h + gap);
    const label = (text: string, size: number, at: string) => font ? `drawtext=fontfile=${filterPath(font)}:text='${text}':fontsize=${size}:fontcolor=white:box=1:boxcolor=black@0.7:boxborderw=4:${at}` : "";
    // Light canvas: the gaps between tiles show where each picture starts, however dark it is.
    const empty = missing.flatMap(({ r, c }) => [
      `drawbox=x=${x(c)}:y=${y(r)}:w=${tile.w}:h=${tile.h}:color=0x8a1c1c:t=fill`,
      label(translate("{0}. {1} No image", r + 1, c + 1), 18, `x=${x(c) + 6}:y=${y(r) + 6}`),
    ]).filter(Boolean);
    const chain = [`color=c=0xd8d8d8:s=${x(cols)}x${y(rows.length)}:d=1${empty.length ? `,${empty.join(",")}` : ""}[base]`];
    let last = "base";
    cells.forEach((cell, i) => {
      const number = label(`${cell.r + 1}.${cell.c + 1}`, 22, "x=6:y=6");
      chain.push(`[${i}:v]scale=${tile.w}:${tile.h}:force_original_aspect_ratio=increase,crop=${tile.w}:${tile.h},setsar=1${number ? `,${number}` : ""}[t${i}]`);
      chain.push(`[${last}][t${i}]overlay=${x(cell.c)}:${y(cell.r)}[o${i}]`);
      last = `o${i}`;
    });
    const out = path.join(dir, "sheet.jpg");
    await runFfmpeg(["-v", "error", "-y", ...cells.flatMap((cell) => ["-i", cell.file]), "-filter_complex", chain.join(";"), "-map", `[${last}]`, "-frames:v", "1", "-q:v", "5", out]);
    return { image: fs.readFileSync(out).toString("base64"), missing: missing.map(({ r, c }) => `${r + 1}.${c + 1}`) };
  } catch (error) {
    console.error("[broll-sheet]", error);
    return null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** What each scene says and what each of its shots searched for, keyed as on the sheet. */
export function brollLegend(p: ProjectWithRelations, missing: string[] = []): string {
  return p.scenes.map((s, i) => {
    const said = (s.narration ?? "").replace(/\s+/g, " ").trim();
    const shots = (s.shots ?? []).map((shot, j) => {
      const key = `${i + 1}.${j + 1}`;
      const note = !shot.selected ? translate(" (no clip)") : missing.includes(key) ? translate(" (no image on the sheet: check it with preview_scene)") : "";
      return `${key} «${shot.query}»${note}`;
    }).join(", ");
    return translate("- Scene {0}: \"{1}\" → {2}", i + 1, said.length > 140 ? `${said.slice(0, 140)}…` : said, shots || translate("No plans"));
  }).join("\n");
}

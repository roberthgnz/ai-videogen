import { t as translate } from "@/lib/i18n";
import fs from "node:fs";
import path from "node:path";
import { AUDIO_EXTENSIONS, listMusic, listSfx } from "@/lib/pipeline/audio/music";
import { readMediaUpload } from "@/lib/editing/upload";
import { storagePaths } from "@/lib/storage";

const MAX_TRACK_BYTES = 60 * 1024 * 1024;

/**
 * Adds a song to the music library (storage/music), or with ?kind=sfx a sound effect (storage/sfx): where
 * generated videos take their background music and transition sounds from. The person picks the file in
 * the studio instead of finding the folder on disk.
 */
export async function POST(request: Request) {
  const sfx = new URL(request.url).searchParams.get("kind") === "sfx";
  try {
    const file = await readMediaUpload(request);
    const ext = path.extname(file.name).toLowerCase();
    if (!AUDIO_EXTENSIONS.includes(ext)) throw new Error(translate("Put an audio in {0}.", AUDIO_EXTENSIONS.map((e) => e.slice(1).toUpperCase()).join(", ")));
    if (file.size > MAX_TRACK_BYTES) throw new Error("El audio pasa de 60 MB.");
    // A plain file name inside the folder: no paths, no characters Windows refuses, never overwriting another file.
    const stem = path.basename(file.name, path.extname(file.name)).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/^\.+/, "").trim().slice(0, 100) || (sfx ? "efecto" : "cancion");
    const dir = sfx ? storagePaths.sfx() : storagePaths.music();
    fs.mkdirSync(dir, { recursive: true });
    const bytes = Buffer.from(await file.arrayBuffer());
    // The same file added twice is the same song: reuse it instead of filling the library with copies.
    const same = fs.readdirSync(dir).find((existing) => {
      const full = path.join(dir, existing);
      try { return fs.statSync(full).size === bytes.length && fs.readFileSync(full).equals(bytes); } catch { return false; }
    });
    if (same) return Response.json({ name: same, music: listMusic(), sfx: listSfx().length });
    let name = `${stem}${ext}`;
    for (let n = 2; fs.existsSync(path.join(dir, name)); n++) name = `${stem} (${n})${ext}`;
    fs.writeFileSync(path.join(dir, name), bytes);
    return Response.json({ name, music: listMusic(), sfx: listSfx().length });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : translate("The audio could not be added.") }, { status: 400 });
  }
}

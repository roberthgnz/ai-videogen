import { t as translate } from "@/lib/i18n";
import { importMedia, MAX_UPLOAD_BYTES } from "@/lib/editing/media";
import { readMediaUpload } from "@/lib/editing/upload";
import { getProject } from "@/lib/projects";

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!getProject(id)) return Response.json({ error: translate("Project not found.") }, { status: 404 });
  if (Number(request.headers.get("content-length")) > MAX_UPLOAD_BYTES + 65536)
    return Response.json({ error: translate("The limit is 256 MB per file.") }, { status: 413 });
  try {
    const file = await readMediaUpload(request);
    // ?place=1: also put it on the timeline (the multi-file import).
    const edit = await importMedia(id, file, { place: new URL(request.url).searchParams.get("place") === "1" });
    return Response.json({ edit });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : translate("You couldn't import the file.") }, { status: 400 });
  }
}

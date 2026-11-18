import { t as translate } from "@/lib/i18n";
import { importGlobalAssetToProject } from "@/lib/global-assets";

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const body = await request.json();
    const projectId = body?.projectId;
    if (!projectId || typeof projectId !== "string") {
      return Response.json({ error: translate("The projectId is missing.") }, { status: 400 });
    }

    const edit = importGlobalAssetToProject(projectId, id);
    return Response.json({ ok: true, edit });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : translate("Error when importing the asset to the project.") },
      { status: 400 },
    );
  }
}

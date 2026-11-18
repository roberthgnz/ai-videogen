import { t as translate } from "@/lib/i18n";
import { deleteGlobalAsset, getGlobalAsset } from "@/lib/global-assets";

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const asset = getGlobalAsset(id);
  if (!asset) return Response.json({ error: "Asset no encontrado." }, { status: 404 });
  return Response.json({ asset });
}

export async function DELETE(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const ok = await deleteGlobalAsset(id);
  if (!ok) return Response.json({ error: translate("The asset could not be removed or not exist.") }, { status: 404 });
  return Response.json({ ok: true });
}

import { t as translate } from "@/lib/i18n";
import { z } from "zod";
import { analyzeMedia } from "@/lib/editing/media";

const input = z.object({ assetId: z.uuid(), operation: z.enum(["transcribe", "silences", "beats"]) });

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const data = input.parse(await request.json());
    return Response.json(await analyzeMedia(id, data.assetId, data.operation));
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : translate("You couldn't analyze the audio.") }, { status: 400 });
  }
}

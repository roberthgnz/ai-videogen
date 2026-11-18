import { t as translate } from "@/lib/i18n";
import { z } from "zod";
import { transcriptEnergy, transcriptPauses, transcriptWords } from "@/lib/editing/transcript-store";

const input = z.object({
  assetId: z.string().min(1).max(80),
  /** Transcribe the file when it has no word timings yet (slow the first time). */
  transcribe: z.boolean().default(false),
  /** Also measure its quiet stretches, for the cleanup proposal. */
  pauses: z.boolean().default(false),
  /** Also its level envelope, which places each cut where the sound really ends or starts. */
  energy: z.boolean().default(false),
});

/** The words of a file of the project with their seconds, and optionally its quiet stretches and level. */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const data = input.parse(await request.json());
    const words = await transcriptWords(id, data.assetId, data.transcribe);
    const [pauses, energy] = await Promise.all([
      data.pauses && words ? transcriptPauses(id, data.assetId) : undefined,
      // Without it cuts still work, from the word timings alone.
      data.energy && words ? transcriptEnergy(id, data.assetId).catch(() => null) : undefined,
    ]);
    return Response.json({ words, pauses, energy });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : translate("You couldn't read the transcript.") }, { status: 400 });
  }
}

import type { NextRequest } from "next/server";
import { connection } from "next/server";
import { errorMessage } from "@/lib/pipeline/errors";
import { getTtsProvider, type Voice } from "@/lib/pipeline/tts";

// Voices rarely change: keep the list in memory for a few minutes.
const TTL_MS = 10 * 60 * 1000;
const globalForVoices = globalThis as unknown as { __videogenVoices?: { at: number; voices: Voice[] } };

export async function GET(request: NextRequest) {
  await connection();
  const refresh = request.nextUrl.searchParams.has("refresh");
  const cached = globalForVoices.__videogenVoices;
  if (!refresh && cached && Date.now() - cached.at < TTL_MS) {
    return Response.json({ voices: cached.voices });
  }
  try {
    const voices = await getTtsProvider().listVoices();
    globalForVoices.__videogenVoices = { at: Date.now(), voices };
    return Response.json({ voices });
  } catch (error) {
    return Response.json({ error: errorMessage(error) }, { status: 502 });
  }
}

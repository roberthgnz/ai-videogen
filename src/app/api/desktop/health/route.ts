import { connection } from "next/server";

export async function GET(request: Request) {
  await connection();
  if (process.env.VIDEOGEN_DESKTOP !== "1" || request.headers.get("x-videogen-session") !== process.env.VIDEOGEN_SESSION_TOKEN) {
    return new Response(null, { status: 404 });
  }
  return Response.json({ ready: true });
}

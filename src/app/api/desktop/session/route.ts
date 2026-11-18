import { connection } from "next/server";
import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";

export async function GET(request: NextRequest) {
  await connection();
  const expected = Buffer.from(process.env.VIDEOGEN_SESSION_TOKEN ?? "");
  const supplied = Buffer.from(request.nextUrl.searchParams.get("token") ?? "");
  if (process.env.VIDEOGEN_DESKTOP !== "1" || !expected.length || expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
    return new Response(null, { status: 404 });
  }
  const path = request.nextUrl.searchParams.get("next") ?? "/";
  if (path !== "/" && !/^\/projects\/[0-9a-f-]{36}$/.test(path)) return new Response(null, { status: 400 });
  const response = NextResponse.redirect(new URL(path, process.env.VIDEOGEN_ORIGIN));
  response.cookies.set("videogen-session", expected.toString(), { httpOnly: true, sameSite: "strict", path: "/" });
  response.headers.set("cache-control", "no-store");
  response.headers.set("referrer-policy", "no-referrer");
  return response;
}

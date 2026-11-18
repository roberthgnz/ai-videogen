import { NextResponse, type NextRequest } from "next/server";

/** The native webview is the only client of the desktop server. */
export function proxy(request: NextRequest) {
  if (process.env.VIDEOGEN_DESKTOP !== "1") return NextResponse.next();
  if (request.nextUrl.pathname === "/api/desktop/session") return NextResponse.next();
  const token = process.env.VIDEOGEN_SESSION_TOKEN;
  const supplied = request.cookies.get("videogen-session")?.value ?? request.headers.get("x-videogen-session");
  if (!token || supplied !== token) return new NextResponse(null, { status: 403 });
  const origin = request.headers.get("origin");
  if (origin && origin !== process.env.VIDEOGEN_ORIGIN) return new NextResponse(null, { status: 403 });
  return NextResponse.next();
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico|fonts/).*)"] };

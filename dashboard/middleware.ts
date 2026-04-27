import { NextResponse, type NextRequest } from "next/server";

const PUBLIC_PATHS = ["/login", "/api/login", "/_next", "/favicon.ico"];

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Bearer-token protected endpoints (used by the extension / automation).
  // Match /api/ingest and /api/enrich exactly — NOT /api/enrich-ui, which is
  // cookie-protected and used by the dashboard UI itself.
  const isBearerEndpoint =
    pathname === "/api/ingest" ||
    pathname.startsWith("/api/ingest/") ||
    pathname === "/api/enrich" ||
    pathname.startsWith("/api/enrich/") ||
    pathname === "/api/find-next-button";
  if (isBearerEndpoint) {
    const auth = req.headers.get("authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!process.env.INGEST_TOKEN || token !== process.env.INGEST_TOKEN) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/cleanup")) {
    const url = req.nextUrl;
    const token = url.searchParams.get("token") ?? req.headers.get("x-cleanup-token") ?? "";
    if (!process.env.CLEANUP_TOKEN || token !== process.env.CLEANUP_TOKEN) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    return NextResponse.next();
  }

  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  const session = req.cookies.get("dashboard_auth")?.value;
  if (!session || session !== process.env.DASHBOARD_PASSWORD) {
    const loginUrl = new URL("/login", req.url);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};

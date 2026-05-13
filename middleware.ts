import { NextResponse, type NextRequest } from "next/server";
import { verifyAuthToken, AUTH_COOKIE } from "@/lib/auth/sign";

// Paths that should never trigger an auth check.
const PUBLIC_PATHS = new Set<string>([
  "/login",
  "/api/auth/login",
  "/api/auth/logout",
]);

function isPublicPath(pathname: string): boolean {
  if (PUBLIC_PATHS.has(pathname)) return true;
  // Next.js internals & static assets
  if (
    pathname.startsWith("/_next/") ||
    pathname === "/favicon.ico" ||
    pathname === "/robots.txt" ||
    pathname === "/sitemap.xml"
  ) {
    return true;
  }
  return false;
}

export async function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  if (isPublicPath(pathname)) return NextResponse.next();

  const token = req.cookies.get(AUTH_COOKIE.name)?.value;
  const valid = await verifyAuthToken(token);

  if (valid) return NextResponse.next();

  // For API routes, return 401 JSON instead of redirecting.
  if (pathname.startsWith("/api/")) {
    return NextResponse.json(
      { ok: false, error: "Not authenticated" },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  const loginUrl = req.nextUrl.clone();
  loginUrl.pathname = "/login";
  // Preserve where the user was trying to go so we can bounce them back after login.
  if (pathname !== "/" && pathname !== "/login") {
    loginUrl.searchParams.set("next", pathname + search);
  } else {
    loginUrl.searchParams.delete("next");
  }
  return NextResponse.redirect(loginUrl);
}

export const config = {
  // Run middleware on everything except static asset requests.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml).*)"],
};

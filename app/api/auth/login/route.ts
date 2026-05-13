import { NextResponse, type NextRequest } from "next/server";
import { signAuthToken, AUTH_COOKIE } from "@/lib/auth/sign";
import { checkRateLimit } from "@/lib/auth/rate-limit";

export const runtime = "nodejs";

function getClientIp(req: NextRequest): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim();
  const real = req.headers.get("x-real-ip");
  if (real) return real;
  return "unknown";
}

export async function POST(req: NextRequest) {
  const ip = getClientIp(req);
  const limit = checkRateLimit(`login:${ip}`);
  if (!limit.allowed) {
    return NextResponse.json(
      {
        ok: false,
        error: `Too many attempts. Try again in ${limit.retryAfterSec}s.`,
      },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSec) } },
    );
  }

  const expected = process.env.APP_PASSWORD;
  if (!expected) {
    return NextResponse.json(
      { ok: false, error: "APP_PASSWORD is not configured on the server." },
      { status: 500 },
    );
  }

  let body: { password?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request body" }, { status: 400 });
  }

  if (!body.password || body.password !== expected) {
    return NextResponse.json(
      { ok: false, error: "Incorrect password.", attemptsRemaining: limit.remaining },
      { status: 401 },
    );
  }

  const token = await signAuthToken();
  const res = NextResponse.json({ ok: true });
  res.cookies.set({
    name: AUTH_COOKIE.name,
    value: token,
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: AUTH_COOKIE.maxAgeSeconds,
  });
  return res;
}

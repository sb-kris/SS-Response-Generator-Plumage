// Edge-Runtime-safe HMAC token signing using Web Crypto API.
// Token format: `<timestamp>.<hex-signature>`

const COOKIE_NAME = "plumage_auth";
const MAX_AGE_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

function getSecret(): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error(
      "AUTH_SECRET env var is missing or too short. Generate one with `openssl rand -hex 32`.",
    );
  }
  return secret;
}

async function hmacHex(secret: string, data: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

export async function signAuthToken(): Promise<string> {
  const ts = Date.now();
  const sig = await hmacHex(getSecret(), `auth:${ts}`);
  return `${ts}.${sig}`;
}

export async function verifyAuthToken(token: string | undefined): Promise<boolean> {
  if (!token) return false;
  const dot = token.indexOf(".");
  if (dot < 0) return false;
  const tsStr = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const ts = parseInt(tsStr, 10);
  if (!Number.isFinite(ts)) return false;
  if (Date.now() - ts > MAX_AGE_MS) return false;
  const expected = await hmacHex(getSecret(), `auth:${ts}`);
  return safeEqual(sig, expected);
}

export const AUTH_COOKIE = {
  name: COOKIE_NAME,
  maxAgeSeconds: Math.floor(MAX_AGE_MS / 1000),
} as const;

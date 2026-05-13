// Simple in-memory rate limiter for the login endpoint.
//
// LIMITATION: On Vercel serverless, each function instance has its own memory,
// so an attacker could bypass this by spreading requests across cold starts.
// For an internal-team tool with a strong APP_PASSWORD this is acceptable.
// If we ever expose this app more broadly, swap in Upstash Redis.

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();
const WINDOW_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;

export function checkRateLimit(identifier: string): {
  allowed: boolean;
  remaining: number;
  retryAfterSec: number;
} {
  const now = Date.now();
  const bucket = buckets.get(identifier);

  if (!bucket || bucket.resetAt < now) {
    buckets.set(identifier, { count: 1, resetAt: now + WINDOW_MS });
    return { allowed: true, remaining: MAX_ATTEMPTS - 1, retryAfterSec: 0 };
  }

  if (bucket.count >= MAX_ATTEMPTS) {
    return {
      allowed: false,
      remaining: 0,
      retryAfterSec: Math.ceil((bucket.resetAt - now) / 1000),
    };
  }

  bucket.count += 1;
  return {
    allowed: true,
    remaining: MAX_ATTEMPTS - bucket.count,
    retryAfterSec: 0,
  };
}

// Best-effort cleanup so the map doesn't grow unbounded across cold function lifetimes.
// (No-op if the runtime tears down often.)
if (typeof setInterval !== "undefined") {
  setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets.entries()) {
      if (bucket.resetAt < now) buckets.delete(key);
    }
  }, WINDOW_MS).unref?.();
}

// Suppresses the harmless `Error: aborted, code: ECONNRESET` (and the matching
// unhandledRejection variant) that Node + undici emit asynchronously when a
// streaming HTTP request is cancelled by the client mid-flight.
//
// This is a known Next.js / undici interaction:
//   - Client opens an SSE stream, then disconnects (Cancel button, tab close).
//   - undici's underlying socket cleanup fires AFTER our route's try/catch has
//     already returned, so the error has no listener.
//   - Node escalates it to `uncaughtException` and crashes the dev server.
//
// We intentionally only suppress this *specific* error pattern. Any other
// uncaughtException / unhandledRejection still bubbles up so real bugs aren't
// hidden.
//
// Idempotent — calling `installDisconnectSuppressor()` more than once is a
// no-op. Safe to import from any route module that streams responses.

let installed = false;

export function installDisconnectSuppressor(): void {
  if (installed) return;
  installed = true;

  process.on("uncaughtException", (err: unknown) => {
    if (isClientDisconnect(err)) return;
    // Re-throw on the next tick so Node's default handler still sees real bugs.
    // Without this, a process.on listener swallows everything.
    process.nextTick(() => {
      throw err;
    });
  });

  process.on("unhandledRejection", (reason: unknown) => {
    if (isClientDisconnect(reason)) return;
    process.nextTick(() => {
      throw reason;
    });
  });
}

function isClientDisconnect(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: unknown; name?: unknown; message?: unknown };
  if (e.code === "ECONNRESET") return true;
  if (e.code === "ERR_STREAM_PREMATURE_CLOSE") return true;
  // Some Node versions surface this as an Error whose .message is just "aborted".
  if (typeof e.message === "string" && e.message.toLowerCase() === "aborted") return true;
  return false;
}

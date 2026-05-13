// Lightweight relative-date formatter for survey lists ("modified 3d ago").
// Falls back to an absolute date for anything older than a week.

const DAY_MS = 24 * 60 * 60 * 1000;

export function formatRelativeDate(input: string | number | undefined | null): string {
  if (!input) return "";
  const ts = typeof input === "number" ? input : Date.parse(input);
  if (!Number.isFinite(ts)) return "";

  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 24 * 3_600_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 7 * DAY_MS) return `${Math.floor(diff / DAY_MS)}d ago`;
  // Older than a week — show absolute date.
  return new Date(ts).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

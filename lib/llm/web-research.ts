// Phase 8b — Web research for the AI Setup Assistant.
//
// Two strategies, selected by provider capability:
//
//   1. LLM-native web search (Anthropic today; OpenAI / Gemini deferred).
//      The model browses inside the API call via the provider's tool.
//      We don't run a separate research call — we ask the model to
//      research AND produce the brief in one shot. This file just owns
//      the "build the web-search-aware Anthropic request" path.
//
//   2. Server-side homepage fetch (every other provider).
//      We GET https://<website>, strip HTML to readable text, cap at
//      ~2KB, and inject the result into the prompt as a research block.
//      Lower quality than full web search but works for any provider.
//
// Both paths return a `CompanyResearchNotes` string the prompt builder
// can drop into the user message verbatim. Empty string = no research,
// the LLM relies purely on the supplied inputs.
//
// SECURITY: server-side fetches go from our Node runtime, not the user's
// browser. We send no credentials, no cookies, and never persist the
// fetched HTML.

import type { LLMProvider } from "@/lib/llm/models";

// ---------------------------------------------------------------------------
// Capability check
// ---------------------------------------------------------------------------

/**
 * Providers whose API supports a server-executed web search tool.
 *
 * Anthropic — `web_search_20250305` tool on the Messages API. Confirmed.
 * Others    — not yet wired here. OpenAI's Responses API + web_search_preview
 *             tool works but uses a different request shape than chat/completions,
 *             so we treat it as Phase 9. Same for Gemini's search grounding.
 */
export function providerSupportsWebSearch(provider: LLMProvider): boolean {
  return provider === "anthropic";
}

// ---------------------------------------------------------------------------
// Strategy 2 — server-side homepage fetch (for providers w/o web search).
// ---------------------------------------------------------------------------

export interface HomepageFetchInput {
  websiteRaw: string; // user-supplied; may or may not include https://
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface HomepageFetchResult {
  ok: boolean;
  /** Cleaned, readable text extracted from the homepage. Empty if fetch
   *  failed or page was empty/non-HTML. */
  text: string;
  /** Final URL we fetched (after https:// normalisation). */
  url?: string;
  error?: string;
}

const MAX_HOMEPAGE_BYTES = 200 * 1024; // 200 KB raw HTML cap
const MAX_RESEARCH_TEXT_LENGTH = 2_000; // ~2 KB cleaned text injected into prompt
const FETCH_TIMEOUT_MS = 6_000;

/**
 * Best-effort homepage fetch + plain-text extraction.
 *
 * - Always resolves; never throws. Errors surface in `result.error`.
 * - Aborts after `timeoutMs` (default 6s).
 * - Caps the response body at 200 KB to avoid pulling in mega-pages.
 * - Strips scripts / styles / nav noise heuristically; not a full DOM
 *   parser. Good enough for "tell the LLM what this company does"
 *   research context.
 */
export async function fetchCompanyHomepage(
  input: HomepageFetchInput,
): Promise<HomepageFetchResult> {
  const url = normaliseUrl(input.websiteRaw);
  if (!url) {
    return { ok: false, text: "", error: "Invalid website URL." };
  }
  // Combined abort: external signal + internal timeout. If either fires we
  // bail out and return an error result.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), input.timeoutMs ?? FETCH_TIMEOUT_MS);
  const externalAbort = () => ctrl.abort();
  if (input.signal) input.signal.addEventListener("abort", externalAbort, { once: true });

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        // Identify ourselves honestly — many sites block default Node UAs.
        "User-Agent":
          "PlumageBot/1.0 (+https://github.com/sb-kris/Plumage-Response-Generator; demo-data-research)",
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en",
      },
      signal: ctrl.signal,
      redirect: "follow",
      cache: "no-store",
    });
    clearTimeout(timer);
    if (input.signal) input.signal.removeEventListener("abort", externalAbort);

    if (!res.ok) {
      return { ok: false, text: "", url, error: `Homepage returned HTTP ${res.status}.` };
    }
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("html")) {
      return { ok: false, text: "", url, error: `Homepage content-type was ${contentType || "unknown"}.` };
    }
    // Cap the body size while reading so a giant single-page site can't
    // blow out our memory budget.
    const reader = res.body?.getReader();
    if (!reader) {
      return { ok: false, text: "", url, error: "Homepage body was empty." };
    }
    const chunks: Uint8Array[] = [];
    let received = 0;
    while (received < MAX_HOMEPAGE_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        received += value.byteLength;
      }
    }
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
    const html = new TextDecoder("utf-8", { fatal: false }).decode(concat(chunks));
    const text = extractReadableText(html).slice(0, MAX_RESEARCH_TEXT_LENGTH);
    if (!text) {
      return { ok: false, text: "", url, error: "Homepage had no extractable text." };
    }
    return { ok: true, text, url };
  } catch (err) {
    clearTimeout(timer);
    if (input.signal) input.signal.removeEventListener("abort", externalAbort);
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      ok: false,
      text: "",
      url,
      error: aborted ? "Homepage fetch timed out." : err instanceof Error ? err.message : "Homepage fetch failed.",
    };
  }
}

// ---------------------------------------------------------------------------
// Plain-text extraction — heuristic, no DOM parser dependency.
// ---------------------------------------------------------------------------

/**
 * Strip HTML to a readable text run. Drops scripts, styles, and most
 * structural noise. Not Reader-Mode-clean, but enough to give the LLM
 * the homepage's headline value-prop, product mentions, and footer info.
 *
 * Steps (in order):
 *   1. Drop <script>, <style>, <noscript>, <svg>, <head> blocks entirely.
 *   2. Replace tag breaks with spaces.
 *   3. Decode the handful of HTML entities that matter for readability.
 *   4. Collapse whitespace.
 *   5. Drop lines that are obvious cookie-banner / nav-link noise.
 */
function extractReadableText(html: string): string {
  if (!html) return "";
  // Block-level strips first.
  let out = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, " ")
    .replace(/<head\b[\s\S]*?<\/head>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");

  // Replace block-level tags with newlines so paragraph boundaries survive.
  out = out
    .replace(/<\/(p|div|section|article|li|h[1-6]|br|tr|td|th)\s*>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n");

  // Strip remaining tags.
  out = out.replace(/<[^>]+>/g, " ");

  // Decode the high-frequency entities.
  out = out
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'");

  // Collapse runs of whitespace, normalise line endings.
  out = out.replace(/[ \t\f\v]+/g, " ").replace(/\n[ ]+/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

  // Drop boilerplate lines: very short OR obvious cookie / nav phrases.
  const NOISE_REGEX = /\b(cookie|accept all|sign in|log in|menu|skip to content|©|all rights reserved)\b/i;
  const lines = out
    .split(/\n+/)
    .map((l) => l.trim())
    .filter((l) => l.length >= 30 && !NOISE_REGEX.test(l));

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normaliseUrl(raw: string): string | null {
  let s = raw.trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  try {
    const u = new URL(s);
    // Only http/https — no file://, ftp://, etc.
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    // Strip query / hash for the homepage probe.
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

function concat(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/**
 * Build a single "RESEARCH NOTES" block to drop into the prompt, given
 * raw research text + the source label. Empty string when no research.
 */
export function buildResearchBlock(
  notes: string,
  source: "llm_web_search" | "homepage_fetch" | "skipped",
): string {
  if (!notes.trim()) return "";
  const sourceLabel =
    source === "llm_web_search"
      ? "from a web search you just ran"
      : source === "homepage_fetch"
        ? "from the company's homepage"
        : "(no fresh research)";
  return `COMPANY RESEARCH NOTES (${sourceLabel}) — use these to ground your suggestions, but prefer the user's notes when they conflict:

${notes.trim()}`;
}

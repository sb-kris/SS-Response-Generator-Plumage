"use client";

// Per-survey question cache backed by IndexedDB via idb-keyval.
// Avoids refetching the same survey's questions during a session.
//
// SECURITY: We only cache the question payloads — never API keys. The cache key
// includes a fingerprint derived from `region + apiKey suffix` so two different
// SS workspaces (or the same workspace with a rotated key) don't share entries.
// We never write the API key itself to the store.

import { get, set, del, keys } from "idb-keyval";
import type { Question } from "@/lib/surveysparrow/types";

const KEY_PREFIX = "plumage:questions:v1";
// Records older than this are considered stale and refetched. SurveySparrow
// surveys can change between visits; 30 minutes is a reasonable demo session.
const TTL_MS = 30 * 60 * 1000;

interface CacheRecord {
  surveyId: number;
  fingerprint: string;
  questions: Question[];
  cachedAt: number;
}

// 6-char hex tail of the API key. Avoids storing the full key while still
// distinguishing different keys / workspaces. NOT a security boundary —
// just enough to prevent cross-workspace pollution if a teammate signs in
// to a second workspace in the same browser tab.
function fingerprintFor(region: string, apiKey: string): string {
  const tail = apiKey.length >= 6 ? apiKey.slice(-6) : apiKey;
  return `${region}:${tail}`;
}

function makeKey(surveyId: number, fingerprint: string): string {
  return `${KEY_PREFIX}:${fingerprint}:${surveyId}`;
}

export async function getCachedQuestions(
  region: string,
  apiKey: string,
  surveyId: number,
): Promise<Question[] | null> {
  if (typeof window === "undefined") return null;
  try {
    const fp = fingerprintFor(region, apiKey);
    const record = await get<CacheRecord>(makeKey(surveyId, fp));
    if (!record) return null;
    if (Date.now() - record.cachedAt > TTL_MS) return null;
    if (record.fingerprint !== fp) return null;
    return record.questions;
  } catch {
    return null;
  }
}

export async function setCachedQuestions(
  region: string,
  apiKey: string,
  surveyId: number,
  questions: Question[],
): Promise<void> {
  if (typeof window === "undefined") return;
  try {
    const fp = fingerprintFor(region, apiKey);
    const record: CacheRecord = {
      surveyId,
      fingerprint: fp,
      questions,
      cachedAt: Date.now(),
    };
    await set(makeKey(surveyId, fp), record);
  } catch {
    // Cache failure shouldn't break the user flow.
  }
}

export async function invalidateQuestionsCache(
  region: string,
  apiKey: string,
  surveyId: number,
): Promise<void> {
  if (typeof window === "undefined") return;
  try {
    const fp = fingerprintFor(region, apiKey);
    await del(makeKey(surveyId, fp));
  } catch {
    /* ignore */
  }
}

export async function clearAllQuestionCache(): Promise<void> {
  if (typeof window === "undefined") return;
  try {
    const all = await keys();
    await Promise.all(
      all
        .filter((k) => typeof k === "string" && k.startsWith(KEY_PREFIX))
        .map((k) => del(k as string)),
    );
  } catch {
    /* ignore */
  }
}

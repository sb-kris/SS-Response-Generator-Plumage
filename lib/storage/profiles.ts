"use client";

// Demo profile storage — IndexedDB via idb-keyval.
//
// Layout:
//   plumage:profiles:index → string[]  (list of profile ids, ordered by updatedAt desc)
//   plumage:profiles:item:<id> → DemoProfile
//
// We keep a separate index so /profiles can render a list without deserializing
// every profile, and so we can present an ordered view without scanning all
// keys (idb-keyval's `keys()` order isn't guaranteed).

import { get, set, del, keys } from "idb-keyval";
import {
  validateAndNormalizeProfile,
  defaultDraft,
  CURRENT_SCHEMA_VERSION,
  type DemoProfile,
  type ProfileDraft,
} from "@/lib/profiles/types";

const INDEX_KEY = "plumage:profiles:index";
const ITEM_PREFIX = "plumage:profiles:item:";

const itemKey = (id: string) => `${ITEM_PREFIX}${id}`;

// ----------------------------------------------------------------------------
// id + naming helpers
// ----------------------------------------------------------------------------

function makeId(): string {
  // crypto.randomUUID is available in modern browsers and Node 20+.
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  // Defensive fallback for older runtimes — sufficient for our scale.
  return `prof_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Resolve a non-conflicting profile name.
 * "Foo" → "Foo (2)" → "Foo (3)" if the previous already exist.
 * If `excludeId` is supplied (during rename), that profile's name is ignored.
 */
export async function resolveUniqueName(
  desired: string,
  excludeId?: string,
): Promise<string> {
  const trimmed = desired.trim();
  if (!trimmed) return "Untitled profile";
  const existing = await listProfilesShallow();
  const taken = new Set(
    existing
      .filter((p) => p.id !== excludeId)
      .map((p) => p.name.toLowerCase()),
  );
  if (!taken.has(trimmed.toLowerCase())) return trimmed;

  // Strip an existing suffix so "Foo (2)" → "Foo" → try (2), (3), ...
  const stripped = trimmed.replace(/\s*\(\d+\)\s*$/, "");
  for (let n = 2; n < 1000; n++) {
    const candidate = `${stripped} (${n})`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  // Pathological case — fall back to unique-ish suffix.
  return `${stripped} (${Date.now()})`;
}

// ----------------------------------------------------------------------------
// Index management
// ----------------------------------------------------------------------------

async function readIndex(): Promise<string[]> {
  const idx = await get<string[]>(INDEX_KEY);
  return Array.isArray(idx) ? idx : [];
}

async function writeIndex(ids: string[]): Promise<void> {
  await set(INDEX_KEY, ids);
}

async function indexAdd(id: string): Promise<void> {
  const idx = await readIndex();
  if (!idx.includes(id)) {
    await writeIndex([id, ...idx]);
  }
}

async function indexRemove(id: string): Promise<void> {
  const idx = await readIndex();
  await writeIndex(idx.filter((existing) => existing !== id));
}

async function indexBump(id: string): Promise<void> {
  const idx = await readIndex();
  const remaining = idx.filter((existing) => existing !== id);
  await writeIndex([id, ...remaining]);
}

// ----------------------------------------------------------------------------
// Public CRUD
// ----------------------------------------------------------------------------

export interface ProfileSummary {
  id: string;
  name: string;
  updatedAt: number;
  createdAt: number;
}

/** Cheap list — returns metadata without the full body. */
export async function listProfilesShallow(): Promise<ProfileSummary[]> {
  if (typeof window === "undefined") return [];
  const ids = await readIndex();
  if (ids.length === 0) {
    // Defensive: rebuild the index if it's missing but item entries exist
    // (e.g. someone wiped the index manually).
    return rebuildAndListSummaries();
  }
  const results: ProfileSummary[] = [];
  for (const id of ids) {
    const p = await get<DemoProfile>(itemKey(id));
    if (p) {
      results.push({
        id: p.id,
        name: p.name,
        updatedAt: p.updatedAt,
        createdAt: p.createdAt,
      });
    }
  }
  // Re-sort defensively in case the index drifted.
  results.sort((a, b) => b.updatedAt - a.updatedAt);
  return results;
}

async function rebuildAndListSummaries(): Promise<ProfileSummary[]> {
  const allKeys = await keys();
  const ids: string[] = [];
  const summaries: ProfileSummary[] = [];
  for (const k of allKeys) {
    if (typeof k === "string" && k.startsWith(ITEM_PREFIX)) {
      const id = k.slice(ITEM_PREFIX.length);
      const p = await get<DemoProfile>(k);
      if (p) {
        ids.push(id);
        summaries.push({
          id: p.id,
          name: p.name,
          updatedAt: p.updatedAt,
          createdAt: p.createdAt,
        });
      }
    }
  }
  summaries.sort((a, b) => b.updatedAt - a.updatedAt);
  await writeIndex(summaries.map((s) => s.id));
  return summaries;
}

export async function getProfile(id: string): Promise<DemoProfile | null> {
  if (typeof window === "undefined") return null;
  const p = await get<DemoProfile>(itemKey(id));
  return p ?? null;
}

/** Save a NEW profile from a draft. Returns the persisted profile. */
export async function createProfile(
  desiredName: string,
  draft: ProfileDraft,
): Promise<DemoProfile> {
  const name = await resolveUniqueName(desiredName);
  const now = Date.now();
  const profile: DemoProfile = {
    ...draft,
    id: makeId(),
    name,
    version: CURRENT_SCHEMA_VERSION,
    createdAt: now,
    updatedAt: now,
  };
  await set(itemKey(profile.id), profile);
  await indexAdd(profile.id);
  return profile;
}

/** Update an existing profile in place. */
export async function updateProfile(
  id: string,
  draft: ProfileDraft,
  newName?: string,
): Promise<DemoProfile> {
  const existing = await getProfile(id);
  if (!existing) {
    throw new Error(`Profile ${id} not found.`);
  }
  const name = newName ? await resolveUniqueName(newName, id) : existing.name;
  const profile: DemoProfile = {
    ...draft,
    id: existing.id,
    name,
    version: CURRENT_SCHEMA_VERSION,
    createdAt: existing.createdAt,
    updatedAt: Date.now(),
  };
  await set(itemKey(profile.id), profile);
  await indexBump(profile.id);
  return profile;
}

export async function renameProfile(id: string, newName: string): Promise<DemoProfile> {
  const existing = await getProfile(id);
  if (!existing) throw new Error(`Profile ${id} not found.`);
  const name = await resolveUniqueName(newName, id);
  const next: DemoProfile = { ...existing, name, updatedAt: Date.now() };
  await set(itemKey(id), next);
  await indexBump(id);
  return next;
}

export async function duplicateProfile(id: string): Promise<DemoProfile> {
  const existing = await getProfile(id);
  if (!existing) throw new Error(`Profile ${id} not found.`);
  const draft = profileToDraft(existing);
  return createProfile(`${existing.name} (copy)`, draft);
}

export async function deleteProfile(id: string): Promise<void> {
  await del(itemKey(id));
  await indexRemove(id);
}

// ----------------------------------------------------------------------------
// Import / export
// ----------------------------------------------------------------------------

export interface ProfileExport {
  application: "plumage";
  type: "demo-profile";
  schemaVersion: number;
  exportedAt: number;
  profile: DemoProfile;
}

export function exportProfile(profile: DemoProfile): ProfileExport {
  return {
    application: "plumage",
    type: "demo-profile",
    schemaVersion: CURRENT_SCHEMA_VERSION,
    exportedAt: Date.now(),
    profile,
  };
}

export function exportProfileAsJsonString(profile: DemoProfile): string {
  return JSON.stringify(exportProfile(profile), null, 2);
}

export interface ImportResult {
  ok: boolean;
  profile?: DemoProfile;
  errors?: string[];
}

/**
 * Validate + persist an imported profile. The import is treated as a *new*
 * profile (new id, name de-duplicated) so we never accidentally overwrite an
 * existing profile by id collision when importing across browsers.
 */
export async function importProfileFromJson(json: string): Promise<ImportResult> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    return { ok: false, errors: [`JSON parse error: ${(err as Error).message}`] };
  }

  // Accept both the wrapped export and a bare profile object.
  let candidate: unknown = parsed;
  if (
    parsed &&
    typeof parsed === "object" &&
    (parsed as Record<string, unknown>).profile &&
    (parsed as Record<string, unknown>).type === "demo-profile"
  ) {
    candidate = (parsed as Record<string, unknown>).profile;
  }

  const result = validateAndNormalizeProfile(candidate);
  if (!result.ok) {
    return { ok: false, errors: result.errors.map((e) => `${e.field}: ${e.message}`) };
  }

  const draft = profileToDraft(result.profile);
  const created = await createProfile(result.profile.name || "Imported profile", draft);
  return { ok: true, profile: created };
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

export function profileToDraft(profile: DemoProfile): ProfileDraft {
  // Strip persistence metadata. The remaining shape matches ProfileDraft.
  const { id: _id, name: _name, createdAt: _c, updatedAt: _u, ...rest } = profile;
  void _id;
  void _name;
  void _c;
  void _u;
  return rest;
}

/** Drop everything in the profiles namespace — used on sign-out. */
export async function clearAllProfiles(): Promise<void> {
  if (typeof window === "undefined") return;
  try {
    const allKeys = await keys();
    await Promise.all(
      allKeys
        .filter(
          (k) =>
            typeof k === "string" &&
            (k.startsWith(ITEM_PREFIX) || k === INDEX_KEY),
        )
        .map((k) => del(k as string)),
    );
  } catch {
    /* ignore */
  }
}

/** Provide a dummy seed profile to first-time users so they can poke around. */
export function seedDraft(): ProfileDraft {
  return {
    ...defaultDraft(),
    useCase:
      "Demo for Nexora Living, a premium US smart-home brand. Highlight installation experience, AI-powered features, and customer support quality. Customers are middle-to-upper-income homeowners aged 30–55.",
  };
}

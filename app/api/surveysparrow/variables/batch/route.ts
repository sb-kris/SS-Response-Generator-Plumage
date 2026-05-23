// Phase 8c — Create workspace variables in SurveySparrow.
//
// Wraps POST /v3/variables/batch. Plumage uses this to "rehearse" the
// workspace ahead of a response push: any AI-suggested or manually-added
// custom variable in the draft that doesn't yet exist in the SS workspace
// gets created here, so the push payload's `variables: { ... }` map
// doesn't trip a "variable not found" error.
//
// Endpoint constraints (verified from docs, May 2026):
//   - body.survey_id: number, required
//   - body.variables: 1-50 entries, each with:
//       label       <= 500 chars
//       name        <= 500 chars  (snake_case identifier)
//       description <= 200 chars
//       type        "STRING" | "NUMBER" | "DATE"
//
// If the caller asks for > 50 variables we chunk internally; this route
// returns the union of created entries across chunks and stops at the
// first failed chunk (mirrors the "stop the push on partial failure"
// guidance from the brief).
//
// SECURITY: region + apiKey come in via the request body, used once,
// never persisted or logged.

import { NextResponse, type NextRequest } from "next/server";
import { surveySparrowFetch } from "@/lib/surveysparrow/client";
import { getRegion, type SurveySparrowRegion } from "@/lib/surveysparrow/regions";

export const runtime = "nodejs";
// Up to 50 variables per upstream request × ~1.5s typical latency. A
// chunked sequence of 2-3 requests still finishes well inside this window.
export const maxDuration = 30;

// Hard limits from the SS docs. Anything beyond gets chunked / truncated
// before we hit the upstream so a bad payload doesn't waste a round-trip.
const MAX_BATCH = 50;
const MAX_LABEL_CHARS = 500;
const MAX_NAME_CHARS = 500;
const MAX_DESCRIPTION_CHARS = 200;

const ALLOWED_TYPES: ReadonlySet<string> = new Set(["STRING", "NUMBER", "DATE"]);

interface IncomingVariable {
  label?: string;
  name?: string;
  description?: string;
  type?: string;
}

interface RequestBody {
  region?: string;
  apiKey?: string;
  surveyId?: number | string;
  variables?: IncomingVariable[];
}

/** What we expect SS to return per created variable. Tolerant — coerced. */
interface CreatedVariable {
  id?: number;
  name?: string;
  label?: string;
  type?: string;
  description?: string;
}

interface BatchResponse {
  ok: boolean;
  status: number;
  surveyId: number;
  created: CreatedVariable[];
  failed: Array<{ name: string; error: string }>;
  error?: string;
}

export async function POST(req: NextRequest): Promise<NextResponse<BatchResponse | { ok: false; error: string; status?: number; created?: never; failed?: never; surveyId?: never }>> {
  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request body." }, { status: 400 });
  }

  const region = body.region as SurveySparrowRegion | undefined;
  if (!region || !getRegion(region)) {
    return NextResponse.json({ ok: false, error: "Select a region." }, { status: 400 });
  }
  if (!body.apiKey) {
    return NextResponse.json({ ok: false, error: "API key is required." }, { status: 400 });
  }
  const surveyIdNum =
    typeof body.surveyId === "number"
      ? body.surveyId
      : typeof body.surveyId === "string"
        ? parseInt(body.surveyId, 10)
        : NaN;
  if (!Number.isFinite(surveyIdNum) || surveyIdNum <= 0) {
    return NextResponse.json(
      { ok: false, error: "surveyId must be a positive number." },
      { status: 400 },
    );
  }

  if (!Array.isArray(body.variables) || body.variables.length === 0) {
    return NextResponse.json(
      { ok: false, error: "variables[] must contain at least one entry." },
      { status: 400 },
    );
  }

  // ---- Sanitise + validate each variable ----
  const sanitised: Array<{ label: string; name: string; description: string; type: string }> = [];
  const sanitiseErrors: string[] = [];
  const seenNames = new Set<string>();
  for (let i = 0; i < body.variables.length; i++) {
    const v = body.variables[i]!;
    const name = (v.name ?? "").trim();
    if (!name) {
      sanitiseErrors.push(`variables[${i}]: name is required.`);
      continue;
    }
    const lcName = name.toLowerCase();
    if (seenNames.has(lcName)) {
      // Duplicate within the SAME batch — silently skip, don't fail the
      // whole request. Real-world cause: caller didn't dedupe before
      // sending. We've already deduped at the helper, so this is a
      // belt-and-braces guard.
      continue;
    }
    seenNames.add(lcName);
    const type = (v.type ?? "STRING").toUpperCase();
    if (!ALLOWED_TYPES.has(type)) {
      sanitiseErrors.push(`variables[${i}].type "${type}" not supported — must be STRING / NUMBER / DATE.`);
      continue;
    }
    const label = (v.label ?? name).slice(0, MAX_LABEL_CHARS);
    const description = (v.description ?? "Created by Plumage for demo response generation").slice(
      0,
      MAX_DESCRIPTION_CHARS,
    );
    sanitised.push({
      label,
      name: name.slice(0, MAX_NAME_CHARS),
      description,
      type,
    });
  }

  if (sanitised.length === 0) {
    return NextResponse.json(
      {
        ok: false,
        error: sanitiseErrors.length > 0
          ? `No valid variables to create: ${sanitiseErrors.join(" | ")}`
          : "No valid variables to create.",
      },
      { status: 400 },
    );
  }

  // ---- Chunk + send. Stop on first failed chunk. ----
  const config = { region, apiKey: body.apiKey };
  const created: CreatedVariable[] = [];
  const failed: Array<{ name: string; error: string }> = [];

  for (let i = 0; i < sanitised.length; i += MAX_BATCH) {
    const chunk = sanitised.slice(i, i + MAX_BATCH);
    const result = await surveySparrowFetch<{ data?: CreatedVariable[]; variables?: CreatedVariable[] }>(
      config,
      "/v3/variables/batch",
      {
        method: "POST",
        body: JSON.stringify({
          survey_id: surveyIdNum,
          variables: chunk,
        }),
      },
    );

    if (!result.ok) {
      const errorMsg = result.error ?? `SurveySparrow returned HTTP ${result.status}`;
      for (const v of chunk) failed.push({ name: v.name, error: errorMsg });
      // First failure → stop. Better to surface a clean partial state to
      // the user than blast through expecting later chunks to succeed.
      return NextResponse.json({
        ok: false,
        status: result.status,
        surveyId: surveyIdNum,
        created,
        failed,
        error: errorMsg,
      });
    }

    // The SS endpoint may return the created records in `data.data` or
    // `data.variables` depending on the workspace's API version. Walk
    // both and coerce.
    const returned =
      (Array.isArray(result.data?.data) ? result.data!.data : null) ??
      (Array.isArray(result.data?.variables) ? result.data!.variables : null) ??
      [];
    if (returned.length > 0) {
      for (const r of returned) created.push(r);
    } else {
      // Workspace returned 200/201 but no body envelope we recognised —
      // treat the chunk's submitted names as created. The push flow will
      // surface any remaining "variable not found" errors at push time.
      for (const v of chunk) created.push({ name: v.name, label: v.label, type: v.type });
    }
  }

  return NextResponse.json({
    ok: true,
    status: 200,
    surveyId: surveyIdNum,
    created,
    failed,
  });
}

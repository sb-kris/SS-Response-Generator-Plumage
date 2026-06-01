// Phase 8 — Fetch workspace-level variables from SurveySparrow for a
// specific survey. Used by the AI Setup Assistant dialog to surface
// existing SS variables as one-click suggestions in the Custom Variables
// section.
//
// Endpoint:
//   GET /v3/variables?survey_id=<id>
//
// The SS endpoint is survey-scoped (despite the "workspace variables"
// framing in the docs — `survey_id` is required). We paginate via the
// existing `fetchAllPages` helper so workspaces with many variables
// don't get truncated at the default page size.
//
// SECURITY: region + apiKey are passed in the request body, used once,
// and never stored or logged.

import { NextResponse, type NextRequest } from "next/server";
import { fetchAllPages } from "@/lib/surveysparrow/pagination";
import { getRegion, type SurveySparrowRegion } from "@/lib/surveysparrow/regions";
import type { SurveySparrowVariableSummary } from "@/lib/generation/setup-assistant-types";

export const runtime = "nodejs";

interface VariablesRequest {
  region?: string;
  apiKey?: string;
  surveyId?: number | string;
}

// Loose shape the SS endpoint may return — we coerce known fields and
// quietly drop the rest. The docs list id / name / label / type /
// description; some workspaces have surfaced extra fields, which we ignore.
interface RawSSVariable {
  id?: number | string;
  name?: string;
  label?: string;
  type?: string;
  description?: string;
  [key: string]: unknown;
}

export async function POST(req: NextRequest) {
  let body: VariablesRequest;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request body" }, { status: 400 });
  }

  const region = body.region as SurveySparrowRegion | undefined;
  if (!region || !getRegion(region)) {
    return NextResponse.json({ ok: false, error: "Select a region." }, { status: 400 });
  }
  if (!body.apiKey) {
    return NextResponse.json({ ok: false, error: "API key is required." }, { status: 400 });
  }
  const surveyId = body.surveyId;
  if (surveyId === undefined || surveyId === null || surveyId === "") {
    return NextResponse.json({ ok: false, error: "surveyId is required." }, { status: 400 });
  }
  const surveyIdNum = typeof surveyId === "number" ? surveyId : parseInt(String(surveyId), 10);
  if (!Number.isFinite(surveyIdNum) || surveyIdNum <= 0) {
    return NextResponse.json(
      { ok: false, error: "surveyId must be a positive number." },
      { status: 400 },
    );
  }

  const result = await fetchAllPages<RawSSVariable>(
    { region, apiKey: body.apiKey },
    `/v3/variables?survey_id=${surveyIdNum}`,
    { perPage: 100, maxPages: 10 },
  );

  if (!result.ok) {
    return NextResponse.json(
      {
        ok: false,
        status: result.status,
        error: result.error ?? "Failed to fetch SurveySparrow variables.",
      },
      { status: 200 },
    );
  }

  // Coerce + trim. We keep only the four fields the dialog cares about,
  // PLUS a derived `personaBinding` field that flags variables SS auto-
  // populates from the contact persona (e.g. first_name → persona.firstName).
  // Those variables MUST be excluded from the response-push variables
  // payload — SS rejects the whole response otherwise.
  const variables: SurveySparrowVariableSummary[] = [];
  for (const v of result.data) {
    if (!v || typeof v !== "object") continue;
    const idNum =
      typeof v.id === "number" ? v.id : typeof v.id === "string" ? parseInt(v.id, 10) : NaN;
    if (!Number.isFinite(idNum)) continue;
    const name = typeof v.name === "string" ? v.name.trim() : "";
    if (!name) continue;
    variables.push({
      id: idNum,
      name,
      label: typeof v.label === "string" ? v.label : undefined,
      type: typeof v.type === "string" ? v.type : undefined,
      description: typeof v.description === "string" ? v.description : undefined,
      personaBinding: detectPersonaBinding(v),
    });
  }

  return NextResponse.json({
    ok: true,
    status: result.status,
    surveyId: surveyIdNum,
    variables,
    count: variables.length,
    truncated: Boolean(result.truncated),
  });
}

// ---------------------------------------------------------------------------
// Persona-binding detection
// ---------------------------------------------------------------------------
//
// SurveySparrow workspaces can configure a variable to be auto-populated
// from the contact persona (e.g. FIRST_NAME → persona.firstName). The SS
// dashboard renders these with a "PERSONA" badge. If we push values for
// these variables in a response payload, SS rejects the entire response
// with "Invalid value passed or missing values in payload".
//
// The exact wire shape SS uses for this varies. Observed forms:
//   • `type: "PERSONA"` (top-level type)
//   • a sibling field — `binding` / `mapped_to` / `value` / `source` —
//     whose string value references `persona.firstName` etc.
//
// We probe permissively: any field whose string value mentions
// "persona.<something>" flags the variable as persona-bound. False positives
// here are cheap (we just don't push a value the SS server would have
// auto-populated anyway); false negatives = full push failure.
function detectPersonaBinding(raw: RawSSVariable): string | undefined {
  // (a) Top-level type field — SS sometimes surfaces "PERSONA" directly.
  if (typeof raw.type === "string" && raw.type.trim().toUpperCase() === "PERSONA") {
    return raw.type.trim();
  }
  // (b) Deep scan via JSON.stringify of the whole raw object minus the
  // user-facing label fields (which might happen to contain the word
  // "persona" in plain English, e.g. "Persona Type"). The stringified
  // blob catches references nested inside `properties.mapped_to`,
  // `binding.field`, arrays of objects, or any other shape SS might use.
  // This is intentionally permissive — false positives are cheap
  // (we just don't push a value SS would have auto-populated anyway);
  // false negatives = full push failure.
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k === "name" || k === "label" || k === "description") continue;
    rest[k] = v;
  }
  let blob: string;
  try {
    blob = JSON.stringify(rest);
  } catch {
    return undefined;
  }
  const match = blob.match(/persona\.[a-zA-Z_][a-zA-Z0-9_]*/);
  return match ? match[0] : undefined;
}

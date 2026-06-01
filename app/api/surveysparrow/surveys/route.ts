import { NextResponse, type NextRequest } from "next/server";
import { fetchAllPages } from "@/lib/surveysparrow/pagination";
import type { Survey } from "@/lib/surveysparrow/types";
import { getRegion, type SurveySparrowRegion } from "@/lib/surveysparrow/regions";

export const runtime = "nodejs";

interface SurveysRequest {
  region?: string;
  apiKey?: string;
  // If true, include archived surveys (default: false — most demos don't want them).
  includeArchived?: boolean;
}

export async function POST(req: NextRequest) {
  let body: SurveysRequest;
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

  const archivedFilter = body.includeArchived ? "" : "archived=false";
  const basePath = archivedFilter ? `/v3/surveys?${archivedFilter}` : "/v3/surveys";

  const result = await fetchAllPages<Survey>(
    { region, apiKey: body.apiKey },
    basePath,
    { perPage: 100, maxPages: 50 },
  );

  if (!result.ok) {
    return NextResponse.json(
      {
        ok: false,
        status: result.status,
        error: result.error ?? "Failed to fetch surveys",
        partial: result.data.length > 0 ? result.data.length : undefined,
      },
      { status: 200 },
    );
  }

  // Plumage only generates text-style synthetic responses. A few SS survey
  // types can't accept demo data through the v3/responses/batch flow:
  //
  //   - Conversational  — chat-bot UI, different ingest path
  //   - SocialListening — pulls from external social feeds; not user-answerable
  //
  // We drop both here (case-insensitive, tolerant of casing variants like
  // "social_listening", "Social Listening", "socialListening") rather than
  // show users an option that would fail at push time.
  const filtered = result.data.filter((s) => !isUnsupportedSurveyType(s.survey_type));
  const hiddenCount = result.data.length - filtered.length;

  return NextResponse.json({
    ok: true,
    status: result.status,
    surveys: filtered,
    count: filtered.length,
    hiddenCount,
    truncated: Boolean(result.truncated),
  });
}

// ---------------------------------------------------------------------------
// Survey-type filter
// ---------------------------------------------------------------------------
//
// Case + separator normalisation: SS surfaces survey_type in several
// shapes across workspaces — "Conversational", "SocialListening",
// "social_listening", "Social Listening", "socialListening". Stripping
// non-alphanumerics + lowercasing collapses all those to a single
// canonical form we can compare with a small denylist.

const UNSUPPORTED_SURVEY_TYPES = new Set<string>([
  "conversational",
  "sociallistening",
]);

function isUnsupportedSurveyType(type: string | null | undefined): boolean {
  if (!type) return false;
  const normalized = type.toLowerCase().replace(/[^a-z0-9]/g, "");
  return UNSUPPORTED_SURVEY_TYPES.has(normalized);
}

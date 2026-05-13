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

  // Plumage only generates text-style responses. Conversational surveys (chat-bot
  // style) collect data through a different flow, so we drop them here rather
  // than show users an option that won't work end-to-end.
  const filtered = result.data.filter(
    (s) => (s.survey_type ?? "").toLowerCase() !== "conversational",
  );
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

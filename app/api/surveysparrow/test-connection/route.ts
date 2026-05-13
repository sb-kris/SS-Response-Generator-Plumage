import { NextResponse, type NextRequest } from "next/server";
import { surveySparrowFetch } from "@/lib/surveysparrow/client";
import type { SurveyListResponse } from "@/lib/surveysparrow/types";
import { getRegion, type SurveySparrowRegion } from "@/lib/surveysparrow/regions";

export const runtime = "nodejs";

interface TestRequest {
  region?: string;
  apiKey?: string;
}

export async function POST(req: NextRequest) {
  let body: TestRequest;
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

  // Lightweight probe — list 1 survey. Confirms key + region simultaneously.
  const result = await surveySparrowFetch<SurveyListResponse>(
    { region, apiKey: body.apiKey },
    "/v3/surveys?limit=1",
  );

  if (!result.ok) {
    return NextResponse.json(
      { ok: false, status: result.status, error: result.error ?? "Unknown error" },
      { status: 200 },
    );
  }

  const surveyCount = result.data?.data?.length ?? 0;
  return NextResponse.json({
    ok: true,
    status: result.status,
    region,
    sampleSurveyName: result.data?.data?.[0]?.name ?? null,
    hasSurveys: surveyCount > 0,
  });
}

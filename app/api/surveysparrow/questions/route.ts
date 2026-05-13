import { NextResponse, type NextRequest } from "next/server";
import { fetchAllPages } from "@/lib/surveysparrow/pagination";
import { buildGroupedQuestions, type Question } from "@/lib/surveysparrow/types";
import { getRegion, type SurveySparrowRegion } from "@/lib/surveysparrow/regions";

export const runtime = "nodejs";

interface QuestionsRequest {
  region?: string;
  apiKey?: string;
  surveyId?: number | string;
}

export async function POST(req: NextRequest) {
  let body: QuestionsRequest;
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
    return NextResponse.json({ ok: false, error: "surveyId must be a positive number." }, { status: 400 });
  }

  const result = await fetchAllPages<Question>(
    { region, apiKey: body.apiKey },
    `/v3/questions?survey_id=${surveyIdNum}`,
    { perPage: 100, maxPages: 20 },
  );

  if (!result.ok) {
    return NextResponse.json(
      {
        ok: false,
        status: result.status,
        error: result.error ?? "Failed to fetch questions",
      },
      { status: 200 },
    );
  }

  // Fold GroupRating_Statement / Matrix_Row / etc. children into their
  // parent's `rows` array and remove them from the top-level list.
  const grouped = buildGroupedQuestions(result.data);

  return NextResponse.json({
    ok: true,
    status: result.status,
    surveyId: surveyIdNum,
    questions: grouped,
    count: grouped.length,
    truncated: Boolean(result.truncated),
  });
}

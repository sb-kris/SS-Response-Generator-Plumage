// Per-entry full-payload fetch.
//
// GET /api/logs/{id}
//   Returns the full request/response bodies + headers for one entry, if
//   still present in tier 2 (PAYLOAD_CAP=50). If the entry has been evicted,
//   returns 404 so the UI can render "Payload expired — only summary retained".

import { NextResponse, type NextRequest } from "next/server";
import { getFullPayload } from "@/lib/server/api-log-buffer";

export const runtime = "nodejs";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const payload = getFullPayload(id);
  if (!payload) {
    return NextResponse.json(
      { ok: false, error: "Full payload not available — evicted from the ring buffer." },
      { status: 404 },
    );
  }
  return NextResponse.json(
    { ok: true, payload },
    { headers: { "Cache-Control": "no-store" } },
  );
}

import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

// Returns a snapshot of what's actually stored in the Enrichment table so we
// can see what Grok/OpenAI are returning verbatim. Cookie-protected.

export async function GET(req: NextRequest) {
  const session = req.cookies.get("dashboard_auth")?.value;
  const expected = process.env.DASHBOARD_PASSWORD;
  if (!expected) {
    return NextResponse.json({ error: "DASHBOARD_PASSWORD not set" }, { status: 500 });
  }
  if (!session || session !== expected) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const total = await prisma.enrichment.count();
  const rows = await prisma.enrichment.findMany({
    select: {
      id: true,
      leadId: true,
      ethnicity: true,
      ageLow: true,
      ageHigh: true,
      confidence: true,
      rawResponse: true,
      lead: { select: { name: true, photoUrl: true } },
    },
    orderBy: { id: "desc" },
    take: 25,
  });

  // Group counts by raw ethnicity value (case-sensitive, exactly as stored).
  const distinctRaw: Record<string, number> = {};
  const all = await prisma.enrichment.findMany({ select: { ethnicity: true } });
  for (const r of all) {
    const k = r.ethnicity ?? "—null—";
    distinctRaw[k] = (distinctRaw[k] ?? 0) + 1;
  }

  // Provider info (so you can confirm which API is wired up).
  const provider = (process.env.ENRICH_PROVIDER ?? "grok").toLowerCase();
  const env = {
    ENRICH_PROVIDER: provider,
    XAI_API_KEY_set: !!process.env.XAI_API_KEY,
    XAI_VISION_MODEL: process.env.XAI_VISION_MODEL ?? "grok-2-vision-1212 (default)",
    OPENAI_API_KEY_set: !!process.env.OPENAI_API_KEY,
    OPENAI_VISION_MODEL: process.env.OPENAI_VISION_MODEL ?? "gpt-4o-mini (default)",
  };

  return NextResponse.json({
    total,
    distinctRawEthnicity: distinctRaw,
    env,
    sample: rows.map((r) => ({
      enrichmentId: r.id,
      leadId: r.leadId,
      name: r.lead?.name,
      photoUrl: r.lead?.photoUrl,
      stored: {
        ethnicity: r.ethnicity,
        ageLow: r.ageLow,
        ageHigh: r.ageHigh,
        confidence: r.confidence,
      },
      rawResponse: r.rawResponse,
    })),
  });
}

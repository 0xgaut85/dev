import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { detectFromUrl } from "@/lib/facepp";
import { corsHeaders, preflight } from "@/lib/cors";

const Schema = z.object({
  leadIds: z.array(z.string()).min(1).max(50),
});

export async function OPTIONS() {
  return preflight();
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400, headers: corsHeaders() });
  }

  const parsed = Schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_failed", issues: parsed.error.flatten() },
      { status: 400, headers: corsHeaders() }
    );
  }

  const leads = await prisma.lead.findMany({
    where: { id: { in: parsed.data.leadIds } },
    select: { id: true, photoUrl: true },
  });

  const results: Array<{ leadId: string; ok: boolean; error?: string }> = [];

  for (const lead of leads) {
    if (!lead.photoUrl) {
      results.push({ leadId: lead.id, ok: false, error: "no_photo" });
      continue;
    }
    try {
      const r = await detectFromUrl(lead.photoUrl);
      await prisma.enrichment.upsert({
        where: { leadId: lead.id },
        create: {
          leadId: lead.id,
          ageLow: r.ageLow,
          ageHigh: r.ageHigh,
          ethnicity: r.ethnicity,
          confidence: r.confidence,
          rawResponse: r.raw as object,
        },
        update: {
          ageLow: r.ageLow,
          ageHigh: r.ageHigh,
          ethnicity: r.ethnicity,
          confidence: r.confidence,
          rawResponse: r.raw as object,
        },
      });
      results.push({ leadId: lead.id, ok: true });
    } catch (err) {
      results.push({
        leadId: lead.id,
        ok: false,
        error: err instanceof Error ? err.message : "unknown",
      });
    }
    // QPS-friendly delay for Face++ free tier
    await new Promise((r) => setTimeout(r, 600));
  }

  return NextResponse.json({ ok: true, results }, { headers: corsHeaders() });
}

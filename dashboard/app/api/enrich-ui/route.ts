import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { detectFromUrl } from "@/lib/facepp";

// Cookie-authenticated enrichment endpoint for the dashboard UI.
// (The bearer-protected /api/enrich is for extension/automation use.)

const Schema = z.object({ leadIds: z.array(z.string()).min(1).max(50) });

export async function POST(req: NextRequest) {
  const session = req.cookies.get("dashboard_auth")?.value;
  const expected = process.env.DASHBOARD_PASSWORD;
  if (!expected) {
    return NextResponse.json(
      { error: "DASHBOARD_PASSWORD not set on the server" },
      { status: 500 }
    );
  }
  if (!session || session !== expected) {
    return NextResponse.json({ error: "unauthorized — please re-login" }, { status: 401 });
  }
  if (!process.env.FACEPP_API_KEY || !process.env.FACEPP_API_SECRET) {
    return NextResponse.json(
      { error: "FACEPP_API_KEY / FACEPP_API_SECRET not set on the server" },
      { status: 500 }
    );
  }

  const body = await req.json().catch(() => null);
  const parsed = Schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "validation_failed" }, { status: 400 });
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
    await new Promise((r) => setTimeout(r, 600));
  }

  return NextResponse.json({ ok: true, results });
}

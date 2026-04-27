import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { detectFromUrl } from "@/lib/enrich";

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
  const provider = (process.env.ENRICH_PROVIDER ?? "grok-then-openai").toLowerCase();
  const haveGrok = !!process.env.XAI_API_KEY;
  const haveOpenAI = !!process.env.OPENAI_API_KEY;

  // Single-provider modes need their specific key. Chain modes need at least one.
  if (provider === "grok" && !haveGrok) {
    return NextResponse.json(
      { error: "ENRICH_PROVIDER=grok but XAI_API_KEY is not set" },
      { status: 500 }
    );
  }
  if (provider === "openai" && !haveOpenAI) {
    return NextResponse.json(
      { error: "ENRICH_PROVIDER=openai but OPENAI_API_KEY is not set" },
      { status: 500 }
    );
  }
  if (provider.includes("then") && !haveGrok && !haveOpenAI) {
    return NextResponse.json(
      { error: "Neither XAI_API_KEY nor OPENAI_API_KEY is set on the server" },
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
    select: { id: true, name: true, photoUrl: true },
  });

  console.log(
    `[enrich-ui] starting: ${leads.length} leads, ${leads.filter((l) => l.photoUrl).length} with photo, provider=${provider}`,
  );

  const results: Array<{
    leadId: string;
    name?: string;
    ok: boolean;
    error?: string;
    ethnicity?: string | null;
  }> = [];

  for (const lead of leads) {
    if (!lead.photoUrl) {
      console.log(`[enrich-ui] ${lead.id} (${lead.name}): no_photo`);
      results.push({ leadId: lead.id, name: lead.name, ok: false, error: "no_photo" });
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
      console.log(
        `[enrich-ui] ${lead.id} (${lead.name}): ok ethnicity=${r.ethnicity} ageLow=${r.ageLow} ageHigh=${r.ageHigh}`,
      );
      results.push({
        leadId: lead.id,
        name: lead.name,
        ok: true,
        ethnicity: r.ethnicity,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      console.error(`[enrich-ui] ${lead.id} (${lead.name}) FAILED: ${msg}`);
      results.push({ leadId: lead.id, name: lead.name, ok: false, error: msg });
    }
    await new Promise((r) => setTimeout(r, 300));
  }

  const okCount = results.filter((r) => r.ok).length;
  console.log(`[enrich-ui] done: ${okCount}/${results.length} ok`);

  return NextResponse.json({ ok: true, results });
}

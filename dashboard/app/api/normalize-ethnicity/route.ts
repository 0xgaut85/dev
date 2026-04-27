import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { normalizeEthnicity } from "@/lib/enrich";

// Re-maps already-stored ethnicity strings ("white", "Caucasian", etc.) onto
// our canonical buckets ("WHITE", "BLACK", "ASIAN", "INDIA"). Cookie-protected.

export async function POST(req: NextRequest) {
  const session = req.cookies.get("dashboard_auth")?.value;
  const expected = process.env.DASHBOARD_PASSWORD;
  if (!expected) {
    return NextResponse.json({ error: "DASHBOARD_PASSWORD not set" }, { status: 500 });
  }
  if (!session || session !== expected) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const all = await prisma.enrichment.findMany({
    select: { id: true, ethnicity: true },
  });

  const before: Record<string, number> = {};
  const after: Record<string, number> = {};
  let updated = 0;

  for (const row of all) {
    const cur = row.ethnicity ?? "";
    before[cur || "—null—"] = (before[cur || "—null—"] ?? 0) + 1;
    const norm = normalizeEthnicity(cur);
    if (norm !== row.ethnicity) {
      await prisma.enrichment.update({
        where: { id: row.id },
        data: { ethnicity: norm },
      });
      updated++;
    }
    after[norm ?? "—null—"] = (after[norm ?? "—null—"] ?? 0) + 1;
  }

  return NextResponse.json({ ok: true, updated, total: all.length, before, after });
}

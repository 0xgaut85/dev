import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

// Bulk-delete every lead whose enrichment ethnicity is NOT WHITE (case-insensitive).
// Body: { includeUnenriched?: boolean, dryRun?: boolean }
//   - includeUnenriched=false (default): only delete leads with a known non-WHITE ethnicity.
//   - includeUnenriched=true: also delete leads that have no enrichment yet.
//   - dryRun=true: return counts without deleting.

export async function POST(req: NextRequest) {
  const session = req.cookies.get("dashboard_auth")?.value;
  if (!session || session !== process.env.DASHBOARD_PASSWORD) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    includeUnenriched?: boolean;
    dryRun?: boolean;
  };
  const includeUnenriched = body.includeUnenriched === true;
  const dryRun = body.dryRun === true;

  // Pull every enrichment row that's not WHITE (handles legacy lower-case values too).
  const nonWhiteEnrichments = await prisma.enrichment.findMany({
    where: {
      OR: [
        { ethnicity: { not: "WHITE", mode: "insensitive" } },
      ],
    },
    select: { leadId: true, ethnicity: true },
  });

  // Pure-null ethnicity rows fall under "unenriched" — exclude unless asked.
  const enrichedNonWhiteIds = nonWhiteEnrichments
    .filter((r) => r.ethnicity != null)
    .map((r) => r.leadId);

  let toDelete = new Set<string>(enrichedNonWhiteIds);

  if (includeUnenriched) {
    // Find leads that don't have any enrichment row at all.
    const noEnrichLeads = await prisma.lead.findMany({
      where: { enrichment: null },
      select: { id: true },
    });
    for (const l of noEnrichLeads) toDelete.add(l.id);

    // Also include enrichment rows where ethnicity is explicitly null.
    const nullEnrich = nonWhiteEnrichments.filter((r) => r.ethnicity == null);
    for (const r of nullEnrich) toDelete.add(r.leadId);
  }

  const ids = Array.from(toDelete);

  // Group by stored ethnicity so the response shows what we're about to nuke.
  const byEth: Record<string, number> = {};
  for (const r of nonWhiteEnrichments) {
    if (toDelete.has(r.leadId)) {
      const k = r.ethnicity ?? "—null—";
      byEth[k] = (byEth[k] ?? 0) + 1;
    }
  }

  if (dryRun) {
    return NextResponse.json({
      ok: true,
      dryRun: true,
      wouldDelete: ids.length,
      breakdown: byEth,
    });
  }

  if (ids.length === 0) {
    return NextResponse.json({ ok: true, deleted: 0, breakdown: byEth });
  }

  // Cascade delete: remove dependent rows first.
  await prisma.outreachStatus.deleteMany({ where: { leadId: { in: ids } } });
  await prisma.enrichment.deleteMany({ where: { leadId: { in: ids } } });
  const result = await prisma.lead.deleteMany({ where: { id: { in: ids } } });

  return NextResponse.json({
    ok: true,
    deleted: result.count,
    breakdown: byEth,
  });
}

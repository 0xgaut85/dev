import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

// Auth is enforced by middleware via ?token=<CLEANUP_TOKEN> query param.
// Trigger from a Railway cron service: e.g. daily curl to /api/cleanup?token=...

export async function POST(req: NextRequest) {
  return runCleanup(req);
}

export async function GET(req: NextRequest) {
  return runCleanup(req);
}

async function runCleanup(req: NextRequest) {
  const days = parseInt(process.env.RETENTION_DAYS ?? "90", 10);
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const enrichments = await prisma.enrichment.deleteMany({
    where: { createdAt: { lt: cutoff } },
  });

  // Also drop very old leads that were never marked contacted.
  const leads = await prisma.lead.deleteMany({
    where: {
      scrapedAt: { lt: cutoff },
      outreach: { is: null },
    },
  });

  return NextResponse.json({
    ok: true,
    retentionDays: days,
    cutoff: cutoff.toISOString(),
    enrichmentsDeleted: enrichments.count,
    leadsDeleted: leads.count,
  });
}

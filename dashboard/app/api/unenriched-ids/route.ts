import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

// Returns the IDs of every lead that has no enrichment row yet OR whose
// enrichment has a null ethnicity (failed/refused enrichment). Used by the
// dashboard's "Enrich only un-enriched" button to drive batch enrichment.

export async function GET(req: NextRequest) {
  const session = req.cookies.get("dashboard_auth")?.value;
  if (!session || session !== process.env.DASHBOARD_PASSWORD) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const leads = await prisma.lead.findMany({
    where: {
      OR: [
        { enrichment: null },
        { enrichment: { ethnicity: null } },
      ],
    },
    select: { id: true },
  });

  return NextResponse.json({
    ok: true,
    count: leads.length,
    leadIds: leads.map((l) => l.id),
  });
}

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";

const Schema = z.object({
  leadIds: z.array(z.string()).min(1).max(500),
});

export async function POST(req: NextRequest) {
  const session = req.cookies.get("dashboard_auth")?.value;
  if (!session || session !== process.env.DASHBOARD_PASSWORD) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const parsed = Schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "validation_failed" }, { status: 400 });
  }

  const { leadIds } = parsed.data;
  // Cascade: delete dependent rows first to avoid FK violations.
  await prisma.outreachStatus.deleteMany({ where: { leadId: { in: leadIds } } });
  await prisma.enrichment.deleteMany({ where: { leadId: { in: leadIds } } });
  const result = await prisma.lead.deleteMany({ where: { id: { in: leadIds } } });

  return NextResponse.json({ ok: true, count: result.count });
}

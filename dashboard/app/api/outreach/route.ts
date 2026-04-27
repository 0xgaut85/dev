import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";

const Schema = z.object({
  leadIds: z.array(z.string()).min(1).max(500),
  status: z.enum(["new", "contacted", "replied", "rejected"]),
  notes: z.string().optional(),
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

  const { leadIds, status, notes } = parsed.data;
  const contactedAt = status === "contacted" ? new Date() : undefined;

  for (const leadId of leadIds) {
    await prisma.outreachStatus.upsert({
      where: { leadId },
      create: { leadId, status, notes, contactedAt },
      update: { status, notes, contactedAt },
    });
  }

  return NextResponse.json({ ok: true, count: leadIds.length });
}

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { corsHeaders, preflight } from "@/lib/cors";

const LeadSchema = z.object({
  crunchbaseUrl: z.string().url(),
  name: z.string().min(1),
  photoUrl: z.string().url().optional().nullable(),
  headline: z.string().optional().nullable(),
  company: z.string().optional().nullable(),
  cbRank: z.number().int().optional().nullable(),
  location: z.string().optional().nullable(),
  country: z.string().optional().nullable(),
  industries: z.array(z.string()).optional().default([]),
  hasX: z.boolean().optional().default(false),
  hasLinkedIn: z.boolean().optional().default(false),
  xUrl: z.string().url().optional().nullable(),
  linkedInUrl: z.string().url().optional().nullable(),
  websiteUrl: z.string().url().optional().nullable(),
});

const PayloadSchema = z.object({
  leads: z.array(LeadSchema).min(1).max(500),
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

  const parsed = PayloadSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_failed", issues: parsed.error.flatten() },
      { status: 400, headers: corsHeaders() }
    );
  }

  let inserted = 0;
  let updated = 0;

  for (const lead of parsed.data.leads) {
    const data = {
      crunchbaseUrl: lead.crunchbaseUrl,
      name: lead.name,
      photoUrl: lead.photoUrl ?? null,
      headline: lead.headline ?? null,
      company: lead.company ?? null,
      cbRank: lead.cbRank ?? null,
      location: lead.location ?? null,
      country: lead.country ?? null,
      industries: lead.industries ?? [],
      hasX: lead.hasX ?? false,
      hasLinkedIn: lead.hasLinkedIn ?? false,
      xUrl: lead.xUrl ?? null,
      linkedInUrl: lead.linkedInUrl ?? null,
      websiteUrl: lead.websiteUrl ?? null,
    };

    const existing = await prisma.lead.findUnique({
      where: { crunchbaseUrl: lead.crunchbaseUrl },
      select: { id: true },
    });

    await prisma.lead.upsert({
      where: { crunchbaseUrl: lead.crunchbaseUrl },
      create: data,
      update: data,
    });

    if (existing) updated++;
    else inserted++;
  }

  return NextResponse.json(
    { ok: true, inserted, updated, received: parsed.data.leads.length },
    { headers: corsHeaders() }
  );
}

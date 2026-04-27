import { prisma } from "@/lib/prisma";
import LeadsTable from "@/components/LeadsTable";

export const dynamic = "force-dynamic";

type SearchParams = {
  hasX?: string;
  ethnicity?: string;
  minRank?: string;
  maxRank?: string;
  minAge?: string;
  maxAge?: string;
  minConfidence?: string;
  status?: string;
};

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const where: Record<string, unknown> = {};

  if (sp.hasX === "yes") where.hasX = true;
  else if (sp.hasX === "no") where.hasX = false;

  const minRank = sp.minRank ? parseInt(sp.minRank) : null;
  const maxRank = sp.maxRank ? parseInt(sp.maxRank) : null;
  if (minRank != null || maxRank != null) {
    const rank: Record<string, number> = {};
    if (minRank != null) rank.gte = minRank;
    if (maxRank != null) rank.lte = maxRank;
    where.cbRank = rank;
  }

  const leads = await prisma.lead.findMany({
    where,
    include: { enrichment: true, outreach: true },
    orderBy: [{ cbRank: "asc" }, { scrapedAt: "desc" }],
    take: 1000,
  });

  const minAge = sp.minAge ? parseInt(sp.minAge) : null;
  const maxAge = sp.maxAge ? parseInt(sp.maxAge) : null;
  const ethnicity = sp.ethnicity ?? "";
  const minConfidence = sp.minConfidence ? parseFloat(sp.minConfidence) : 0;
  const status = sp.status ?? "";

  // Compare ethnicity case-insensitively so legacy rows ("white", "White") still match.
  const ethnicityNorm = ethnicity.trim().toUpperCase();

  const filtered = leads.filter((l) => {
    if (status === "new" && l.outreach?.status && l.outreach.status !== "new") return false;
    if (status === "contacted" && l.outreach?.status !== "contacted") return false;

    if (ethnicityNorm || minAge != null || maxAge != null || minConfidence > 0) {
      const e = l.enrichment;
      if (!e) return false;
      if (ethnicityNorm && (e.ethnicity ?? "").trim().toUpperCase() !== ethnicityNorm) return false;
      if (minConfidence > 0 && (e.confidence ?? 0) < minConfidence) return false;
      if (minAge != null && (e.ageHigh ?? 0) < minAge) return false;
      if (maxAge != null && (e.ageLow ?? 999) > maxAge) return false;
    }
    return true;
  });

  // Stats over the un-filtered set, so the banner shows what's actually in the DB
  // regardless of which ethnicity is currently selected in the dropdown.
  const ethnicityStats: Record<string, number> = {};
  let unenriched = 0;
  for (const l of leads) {
    const v = l.enrichment?.ethnicity;
    if (!v) {
      unenriched++;
    } else {
      const k = v.trim().toUpperCase() || "—";
      ethnicityStats[k] = (ethnicityStats[k] ?? 0) + 1;
    }
  }

  const totalCount = await prisma.lead.count();
  const enrichedCount = await prisma.enrichment.count();

  return (
    <main className="max-w-[1400px] mx-auto p-6">
      <header className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold">Crunchbase Lead Finder</h1>
          <p className="text-sm text-slate-600">
            {totalCount} leads total · {enrichedCount} enriched · {filtered.length} matching filters
          </p>
        </div>
        <form action="/api/logout" method="post">
          <button className="text-sm text-slate-600 hover:text-slate-900">Sign out</button>
        </form>
      </header>

      <LeadsTable
        leads={filtered.map((l) => ({
          id: l.id,
          name: l.name,
          company: l.company,
          headline: l.headline,
          photoUrl: l.photoUrl,
          country: l.country,
          location: l.location,
          cbRank: l.cbRank,
          industries: l.industries,
          hasX: l.hasX,
          xUrl: l.xUrl,
          linkedInUrl: l.linkedInUrl,
          crunchbaseUrl: l.crunchbaseUrl,
          enrichment: l.enrichment
            ? {
                ageLow: l.enrichment.ageLow,
                ageHigh: l.enrichment.ageHigh,
                ethnicity: l.enrichment.ethnicity,
                confidence: l.enrichment.confidence,
              }
            : null,
          outreachStatus: l.outreach?.status ?? "new",
        }))}
        searchParams={sp}
        ethnicityStats={ethnicityStats}
        totalLeads={leads.length}
        unenriched={unenriched}
      />
    </main>
  );
}

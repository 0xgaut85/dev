"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

type Lead = {
  id: string;
  name: string;
  company: string | null;
  headline: string | null;
  photoUrl: string | null;
  country: string | null;
  location: string | null;
  cbRank: number | null;
  industries: string[];
  hasX: boolean;
  xUrl: string | null;
  linkedInUrl: string | null;
  crunchbaseUrl: string;
  enrichment: {
    ageLow: number | null;
    ageHigh: number | null;
    ethnicity: string | null;
    confidence: number | null;
  } | null;
  outreachStatus: string;
};

export default function LeadsTable({
  leads,
  searchParams,
  ethnicityStats,
  totalLeads,
  unenriched,
}: {
  leads: Lead[];
  searchParams: Record<string, string | undefined>;
  ethnicityStats: Record<string, number>;
  totalLeads: number;
  unenriched: number;
}) {
  const router = useRouter();
  const sp = useSearchParams();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const toggleAll = () => {
    if (selected.size === leads.length) setSelected(new Set());
    else setSelected(new Set(leads.map((l) => l.id)));
  };

  const updateFilter = (key: string, value: string) => {
    const params = new URLSearchParams(sp.toString());
    if (value) params.set(key, value);
    else params.delete(key);
    router.push(`/?${params.toString()}`);
  };

  const enrichSelected = async () => {
    if (selected.size === 0) return;
    setBusy("enriching");
    try {
      const ids = Array.from(selected).slice(0, 50);
      const res = await fetch("/api/enrich-ui", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ leadIds: ids }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        results?: Array<{ leadId: string; ok: boolean; error?: string }>;
      };
      if (!res.ok) {
        alert(`Enrichment failed (HTTP ${res.status}): ${data.error ?? "unknown error"}`);
        return;
      }
      const results = data.results ?? [];
      const okCount = results.filter((r) => r.ok).length;
      const failed = results.filter((r) => !r.ok);
      if (failed.length === 0) {
        alert(`Enriched ${okCount}/${results.length} leads.`);
      } else {
        const errSummary: Record<string, number> = {};
        for (const f of failed) {
          const k = f.error ?? "unknown";
          errSummary[k] = (errSummary[k] ?? 0) + 1;
        }
        const summary = Object.entries(errSummary)
          .map(([k, v]) => `  ${v}× ${k}`)
          .join("\n");
        alert(
          `Enriched ${okCount}/${results.length} leads.\n${failed.length} failed:\n${summary}\n\nFirst failure detail:\n${failed[0].error ?? "?"}`,
        );
      }
      router.refresh();
    } finally {
      setBusy(null);
    }
  };

  const deleteLead = async (id: string) => {
    if (!confirm("Delete this lead permanently?")) return;
    setBusy("deleting");
    try {
      const res = await fetch("/api/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ leadIds: [id] }),
      });
      if (res.ok) {
        const next = new Set(selected);
        next.delete(id);
        setSelected(next);
        router.refresh();
      } else {
        alert("Delete failed.");
      }
    } finally {
      setBusy(null);
    }
  };

  const deleteSelected = async () => {
    if (selected.size === 0) return;
    if (!confirm(`Delete ${selected.size} lead(s) permanently?`)) return;
    setBusy("deleting");
    try {
      const res = await fetch("/api/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ leadIds: Array.from(selected) }),
      });
      if (res.ok) {
        setSelected(new Set());
        router.refresh();
      } else {
        alert("Delete failed.");
      }
    } finally {
      setBusy(null);
    }
  };

  const markContacted = async () => {
    if (selected.size === 0) return;
    setBusy("marking");
    try {
      const res = await fetch("/api/outreach", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ leadIds: Array.from(selected), status: "contacted" }),
      });
      if (res.ok) {
        setSelected(new Set());
        router.refresh();
      }
    } finally {
      setBusy(null);
    }
  };

  const exportCsv = () => {
    const rows = leads.filter((l) => selected.size === 0 || selected.has(l.id));
    const headers = [
      "name",
      "company",
      "headline",
      "country",
      "location",
      "cbRank",
      "industries",
      "hasX",
      "xUrl",
      "linkedInUrl",
      "crunchbaseUrl",
      "ageLow",
      "ageHigh",
      "ethnicity",
      "confidence",
      "outreachStatus",
    ];
    const escape = (v: unknown) => {
      const s = v == null ? "" : String(v);
      return `"${s.replace(/"/g, '""')}"`;
    };
    const csv = [
      headers.join(","),
      ...rows.map((l) =>
        [
          l.name,
          l.company,
          l.headline,
          l.country,
          l.location,
          l.cbRank,
          l.industries.join(";"),
          l.hasX,
          l.xUrl,
          l.linkedInUrl,
          l.crunchbaseUrl,
          l.enrichment?.ageLow,
          l.enrichment?.ageHigh,
          l.enrichment?.ethnicity,
          l.enrichment?.confidence,
          l.outreachStatus,
        ]
          .map(escape)
          .join(",")
      ),
    ].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `leads-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const enrichedTotal = totalLeads - unenriched;

  return (
    <div className="space-y-4">
      <div className="bg-amber-50 border border-amber-200 text-amber-900 text-xs p-3 rounded-lg">
        <strong>Enrichment status (whole DB):</strong> {enrichedTotal}/{totalLeads} leads have AI vision data.{" "}
        {Object.entries(ethnicityStats)
          .sort((a, b) => b[1] - a[1])
          .map(([k, v]) => `${k}: ${v}`)
          .join(" · ")}
        {unenriched > 0 && ` · —not enriched—: ${unenriched}`}
        {enrichedTotal < totalLeads && (
          <span className="ml-1">
            Filtering by ethnicity hides un-enriched leads — select all and click <em>Enrich with AI</em> first.
          </span>
        )}
      </div>
      <div className="bg-white p-4 rounded-lg shadow-sm grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
        <Field label="Has X">
          <select
            value={searchParams.hasX ?? ""}
            onChange={(e) => updateFilter("hasX", e.target.value)}
            className="input"
          >
            <option value="">Any</option>
            <option value="no">No X account</option>
            <option value="yes">Has X account</option>
          </select>
        </Field>
        <Field label="CB Rank min">
          <input
            type="number"
            defaultValue={searchParams.minRank ?? ""}
            onBlur={(e) => updateFilter("minRank", e.target.value)}
            className="input"
            placeholder="1"
          />
        </Field>
        <Field label="CB Rank max">
          <input
            type="number"
            defaultValue={searchParams.maxRank ?? ""}
            onBlur={(e) => updateFilter("maxRank", e.target.value)}
            className="input"
            placeholder="1000"
          />
        </Field>
        <Field label="Ethnicity">
          <select
            value={searchParams.ethnicity ?? ""}
            onChange={(e) => updateFilter("ethnicity", e.target.value)}
            className="input"
          >
            <option value="">Any</option>
            <option value="WHITE">White</option>
            <option value="BLACK">Black</option>
            <option value="ASIAN">Asian</option>
            <option value="INDIA">India</option>
          </select>
        </Field>
        <Field label="Min confidence">
          <input
            type="number"
            step="0.05"
            min="0"
            max="1"
            defaultValue={searchParams.minConfidence ?? ""}
            onBlur={(e) => updateFilter("minConfidence", e.target.value)}
            className="input"
            placeholder="0.7"
          />
        </Field>
        <Field label="Age min">
          <input
            type="number"
            defaultValue={searchParams.minAge ?? ""}
            onBlur={(e) => updateFilter("minAge", e.target.value)}
            className="input"
          />
        </Field>
        <Field label="Age max">
          <input
            type="number"
            defaultValue={searchParams.maxAge ?? ""}
            onBlur={(e) => updateFilter("maxAge", e.target.value)}
            className="input"
          />
        </Field>
        <Field label="Status">
          <select
            value={searchParams.status ?? ""}
            onChange={(e) => updateFilter("status", e.target.value)}
            className="input"
          >
            <option value="">Any</option>
            <option value="new">New</option>
            <option value="contacted">Contacted</option>
          </select>
        </Field>
      </div>

      <div className="flex flex-wrap items-center gap-2 bg-white p-3 rounded-lg shadow-sm">
        <span className="text-sm text-slate-600">{selected.size} selected</span>
        <button
          onClick={enrichSelected}
          disabled={selected.size === 0 || busy !== null}
          className="btn-primary"
        >
          {busy === "enriching" ? "Enriching…" : "Enrich with AI"}
        </button>
        <button
          onClick={markContacted}
          disabled={selected.size === 0 || busy !== null}
          className="btn"
        >
          Mark contacted
        </button>
        <button onClick={exportCsv} className="btn">
          Export CSV {selected.size > 0 ? `(${selected.size})` : "(all filtered)"}
        </button>
        <button
          onClick={async () => {
            setBusy("normalizing");
            try {
              const res = await fetch("/api/normalize-ethnicity", { method: "POST" });
              const data = await res.json();
              if (!res.ok) {
                alert(`Normalize failed: ${data.error ?? res.status}`);
              } else {
                alert(
                  `Normalized ${data.updated}/${data.total} rows.\n\nBefore: ${JSON.stringify(
                    data.before,
                  )}\n\nAfter: ${JSON.stringify(data.after)}`,
                );
                router.refresh();
              }
            } finally {
              setBusy(null);
            }
          }}
          disabled={busy !== null}
          className="btn"
          title="Re-bucket existing 'white'/'Caucasian'/etc. into WHITE/BLACK/ASIAN/INDIA"
        >
          {busy === "normalizing" ? "Fixing…" : "Fix ethnicity buckets"}
        </button>
        <button
          onClick={async () => {
            // Two-step: dry-run first to show counts, then confirm.
            setBusy("purging");
            try {
              const dry = await fetch("/api/delete-non-white", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ dryRun: true, includeUnenriched: false }),
              });
              const dryData = await dry.json();
              if (!dry.ok) {
                alert(`Dry-run failed: ${dryData.error ?? dry.status}`);
                return;
              }
              const breakdown = Object.entries(dryData.breakdown ?? {})
                .map(([k, v]) => `  ${k}: ${v}`)
                .join("\n") || "  (none)";
              const ok = confirm(
                `This will permanently delete ${dryData.wouldDelete} non-WHITE leads.\n\nBreakdown:\n${breakdown}\n\nUnenriched leads will NOT be deleted.\n\nProceed?`,
              );
              if (!ok) return;

              const res = await fetch("/api/delete-non-white", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ dryRun: false, includeUnenriched: false }),
              });
              const data = await res.json();
              if (!res.ok) {
                alert(`Delete failed: ${data.error ?? res.status}`);
              } else {
                alert(`Deleted ${data.deleted} leads.`);
                setSelected(new Set());
                router.refresh();
              }
            } finally {
              setBusy(null);
            }
          }}
          disabled={busy !== null}
          className="btn-danger"
          title="Permanently remove every lead whose AI-detected ethnicity is not WHITE"
        >
          {busy === "purging" ? "Purging…" : "Delete all non-WHITE"}
        </button>
        <button
          onClick={deleteSelected}
          disabled={selected.size === 0 || busy !== null}
          className="btn-danger"
        >
          {busy === "deleting" ? "Deleting…" : "Delete"}
        </button>
      </div>

      <div className="bg-white rounded-lg shadow-sm overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-100 text-slate-600">
            <tr>
              <th className="p-2 w-8">
                <input
                  type="checkbox"
                  checked={leads.length > 0 && selected.size === leads.length}
                  onChange={toggleAll}
                />
              </th>
              <th className="p-2 text-left">Name</th>
              <th className="p-2 text-left">Company</th>
              <th className="p-2 text-left">Country</th>
              <th className="p-2 text-right">CB Rank</th>
              <th className="p-2 text-left">Industries</th>
              <th className="p-2 text-center">X</th>
              <th className="p-2 text-left">Age</th>
              <th className="p-2 text-left">Ethnicity</th>
              <th className="p-2 text-left">Status</th>
              <th className="p-2"></th>
            </tr>
          </thead>
          <tbody>
            {leads.map((l) => (
              <tr key={l.id} className="border-t hover:bg-slate-50">
                <td className="p-2">
                  <input
                    type="checkbox"
                    checked={selected.has(l.id)}
                    onChange={() => toggle(l.id)}
                  />
                </td>
                <td className="p-2">
                  <div className="flex items-center gap-2">
                    {l.photoUrl && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={l.photoUrl}
                        alt=""
                        className="w-8 h-8 rounded-full object-cover"
                      />
                    )}
                    <div>
                      <div className="font-medium">{l.name}</div>
                      <div className="text-xs text-slate-500">{l.headline}</div>
                    </div>
                  </div>
                </td>
                <td className="p-2">{l.company}</td>
                <td className="p-2">{l.country ?? l.location}</td>
                <td className="p-2 text-right">{l.cbRank ?? "—"}</td>
                <td className="p-2 max-w-[240px]">
                  <div className="flex flex-wrap gap-1">
                    {l.industries.slice(0, 3).map((i) => (
                      <span
                        key={i}
                        className="text-xs bg-slate-100 px-1.5 py-0.5 rounded"
                      >
                        {i}
                      </span>
                    ))}
                  </div>
                </td>
                <td className="p-2 text-center">
                  {l.hasX ? (
                    <a
                      href={l.xUrl ?? "#"}
                      target="_blank"
                      className="text-blue-600"
                    >
                      ✓
                    </a>
                  ) : (
                    <span className="text-green-600 font-semibold">—</span>
                  )}
                </td>
                <td className="p-2">
                  {l.enrichment?.ageLow != null
                    ? `${l.enrichment.ageLow}–${l.enrichment.ageHigh}`
                    : "—"}
                </td>
                <td className="p-2">
                  {l.enrichment?.ethnicity ?? "—"}
                  {l.enrichment?.confidence != null && (
                    <span className="text-xs text-slate-500 ml-1">
                      ({Math.round(l.enrichment.confidence * 100)}%)
                    </span>
                  )}
                </td>
                <td className="p-2">
                  <span
                    className={
                      l.outreachStatus === "contacted"
                        ? "text-xs bg-green-100 text-green-700 px-1.5 py-0.5 rounded"
                        : "text-xs bg-slate-100 px-1.5 py-0.5 rounded"
                    }
                  >
                    {l.outreachStatus}
                  </span>
                </td>
                <td className="p-2">
                  <div className="flex items-center gap-2 justify-end">
                    <a
                      href={l.crunchbaseUrl}
                      target="_blank"
                      className="text-blue-600 text-xs"
                    >
                      CB ↗
                    </a>
                    <button
                      onClick={() => deleteLead(l.id)}
                      disabled={busy !== null}
                      title="Delete this lead"
                      className="text-slate-400 hover:text-red-600 text-base leading-none px-1"
                    >
                      ×
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {leads.length === 0 && (
              <tr>
                <td colSpan={11} className="p-8 text-center text-slate-500">
                  No leads match these filters. Scrape some via the extension.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <style jsx>{`
        .input {
          width: 100%;
          border: 1px solid rgb(203 213 225);
          border-radius: 0.375rem;
          padding: 0.375rem 0.5rem;
          background: white;
        }
        .btn {
          padding: 0.375rem 0.75rem;
          border-radius: 0.375rem;
          border: 1px solid rgb(203 213 225);
          background: white;
        }
        .btn:hover:not(:disabled) {
          background: rgb(241 245 249);
        }
        .btn:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
        .btn-primary {
          padding: 0.375rem 0.75rem;
          border-radius: 0.375rem;
          background: rgb(15 23 42);
          color: white;
        }
        .btn-primary:hover:not(:disabled) {
          background: rgb(30 41 59);
        }
        .btn-primary:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
        .btn-danger {
          padding: 0.375rem 0.75rem;
          border-radius: 0.375rem;
          background: rgb(185 28 28);
          color: white;
          border: none;
        }
        .btn-danger:hover:not(:disabled) {
          background: rgb(153 27 27);
        }
        .btn-danger:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
      `}</style>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-xs text-slate-600">
      <div className="mb-1">{label}</div>
      {children}
    </label>
  );
}

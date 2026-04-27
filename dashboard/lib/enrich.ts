// Provider-agnostic enrichment dispatcher.
//
// ENRICH_PROVIDER env var (default "grok"):
//   "grok"             → xAI Grok vision (most permissive, default)
//   "openai"           → OpenAI GPT-4o-mini vision
//   "grok-then-openai" → Grok first, OpenAI on failure / null ethnicity

import { detectFromUrlLlm } from "./llm-vision";
import { detectFromUrlGrok } from "./grok-vision";

export type EnrichmentResult = {
  ageLow: number | null;
  ageHigh: number | null;
  ethnicity: string | null;
  confidence: number | null;
  raw: unknown;
};

/**
 * Map any ethnicity string (case-insensitive, common variants) to one of
 * our four canonical buckets, or null if we can't classify confidently.
 */
export function normalizeEthnicity(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  if (!v) return null;

  if (["white", "caucasian", "european", "euro"].includes(v)) return "WHITE";
  if (["black", "african", "african american", "afro", "afro-caribbean"].includes(v))
    return "BLACK";
  if (
    [
      "asian",
      "east asian",
      "east_asian",
      "southeast asian",
      "south-east asian",
      "oriental",
    ].includes(v)
  )
    return "ASIAN";
  if (
    ["india", "indian", "south asian", "south-asian", "south_asian", "desi"].includes(v)
  )
    return "INDIA";

  if (/\bwhite\b|\bcaucas/.test(v) || v.includes("european")) return "WHITE";
  if (/\bblack\b|african/.test(v)) return "BLACK";
  if (/\bindia\b|south[\s_-]?asian|desi/.test(v)) return "INDIA";
  if (/asian|chinese|japanese|korean|vietnamese|thai|filipino/.test(v)) return "ASIAN";

  return null;
}

type Detector = (url: string) => Promise<EnrichmentResult>;

function chain(detectors: Detector[]): Detector {
  return async (imageUrl: string) => {
    let lastErr: unknown = null;
    let lastResult: EnrichmentResult | null = null;
    for (const d of detectors) {
      try {
        const r = await d(imageUrl);
        if (r.ethnicity) return r;
        lastResult = r;
      } catch (err) {
        lastErr = err;
      }
    }
    if (lastResult) return lastResult;
    throw lastErr instanceof Error ? lastErr : new Error("all providers failed");
  };
}

export async function detectFromUrl(imageUrl: string): Promise<EnrichmentResult> {
  const provider = (process.env.ENRICH_PROVIDER ?? "grok").toLowerCase();

  switch (provider) {
    case "grok":
      return detectFromUrlGrok(imageUrl);
    case "openai":
      return detectFromUrlLlm(imageUrl);
    case "grok-then-openai":
      return chain([detectFromUrlGrok, detectFromUrlLlm])(imageUrl);
    case "openai-then-grok":
      return chain([detectFromUrlLlm, detectFromUrlGrok])(imageUrl);
    default:
      return detectFromUrlGrok(imageUrl);
  }
}

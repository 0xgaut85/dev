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
  // Default to grok-then-openai so a missing/invalid Grok model silently falls
  // back to OpenAI instead of failing the whole row. Set ENRICH_PROVIDER=openai
  // (or grok) to force a single provider.
  const provider = (process.env.ENRICH_PROVIDER ?? "grok-then-openai").toLowerCase();

  // If a chosen provider's key isn't even set, skip it rather than fail loudly.
  const haveGrok = !!process.env.XAI_API_KEY;
  const haveOpenAI = !!process.env.OPENAI_API_KEY;

  switch (provider) {
    case "grok":
      if (!haveGrok) throw new Error("ENRICH_PROVIDER=grok but XAI_API_KEY is not set");
      return detectFromUrlGrok(imageUrl);
    case "openai":
      if (!haveOpenAI) throw new Error("ENRICH_PROVIDER=openai but OPENAI_API_KEY is not set");
      return detectFromUrlLlm(imageUrl);
    case "grok-then-openai": {
      const chainList: Detector[] = [];
      if (haveGrok) chainList.push(detectFromUrlGrok);
      if (haveOpenAI) chainList.push(detectFromUrlLlm);
      if (chainList.length === 0)
        throw new Error("Neither XAI_API_KEY nor OPENAI_API_KEY is set");
      return chain(chainList)(imageUrl);
    }
    case "openai-then-grok": {
      const chainList: Detector[] = [];
      if (haveOpenAI) chainList.push(detectFromUrlLlm);
      if (haveGrok) chainList.push(detectFromUrlGrok);
      if (chainList.length === 0)
        throw new Error("Neither OPENAI_API_KEY nor XAI_API_KEY is set");
      return chain(chainList)(imageUrl);
    }
    default:
      throw new Error(`Unknown ENRICH_PROVIDER: ${provider}`);
  }
}

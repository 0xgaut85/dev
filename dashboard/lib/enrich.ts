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

export type EnrichmentInput = {
  imageUrl: string;
  name?: string | null;
};

type Detector = (input: EnrichmentInput) => Promise<EnrichmentResult>;

function chain(detectors: Detector[]): Detector {
  return async (input: EnrichmentInput) => {
    let lastErr: unknown = null;
    let lastResult: EnrichmentResult | null = null;
    for (const d of detectors) {
      try {
        const r = await d(input);
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

export async function detectFromUrl(input: EnrichmentInput): Promise<EnrichmentResult> {
  const provider = (process.env.ENRICH_PROVIDER ?? "grok").toLowerCase();

  const haveGrok = !!process.env.XAI_API_KEY;
  const haveOpenAI = !!process.env.OPENAI_API_KEY;

  switch (provider) {
    case "grok":
      if (!haveGrok) throw new Error("ENRICH_PROVIDER=grok but XAI_API_KEY is not set");
      return detectFromUrlGrok(input);
    case "openai":
      if (!haveOpenAI) throw new Error("ENRICH_PROVIDER=openai but OPENAI_API_KEY is not set");
      return detectFromUrlLlm(input);
    case "grok-then-openai": {
      const chainList: Detector[] = [];
      if (haveGrok) chainList.push(detectFromUrlGrok);
      if (haveOpenAI) chainList.push(detectFromUrlLlm);
      if (chainList.length === 0)
        throw new Error("Neither XAI_API_KEY nor OPENAI_API_KEY is set");
      return chain(chainList)(input);
    }
    case "openai-then-grok": {
      const chainList: Detector[] = [];
      if (haveOpenAI) chainList.push(detectFromUrlLlm);
      if (haveGrok) chainList.push(detectFromUrlGrok);
      if (chainList.length === 0)
        throw new Error("Neither OPENAI_API_KEY nor XAI_API_KEY is set");
      return chain(chainList)(input);
    }
    default:
      throw new Error(`Unknown ENRICH_PROVIDER: ${provider}`);
  }
}

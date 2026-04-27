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

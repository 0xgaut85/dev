// Provider-agnostic enrichment dispatcher.
//
// ENRICH_PROVIDER env var (default "grok"):
//   "grok"             → xAI Grok vision (most permissive)
//   "openai"           → GPT-4o-mini vision
//   "facepp"           → Face++ classical CV
//   "grok-then-openai" → Grok first, OpenAI on failure
//   "openai-then-facepp"
//   "grok-then-facepp"

import { detectFromUrl as detectFacepp, type FaceppResult } from "./facepp";
import { detectFromUrlLlm } from "./llm-vision";
import { detectFromUrlGrok } from "./grok-vision";

type Detector = (url: string) => Promise<FaceppResult>;

function chain(detectors: Detector[]): Detector {
  return async (imageUrl: string) => {
    let lastErr: unknown = null;
    for (const d of detectors) {
      try {
        const r = await d(imageUrl);
        if (r.ethnicity) return r;
        lastErr = new Error("ethnicity null");
        // continue to next provider
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error("all providers failed");
  };
}

export async function detectFromUrl(imageUrl: string): Promise<FaceppResult> {
  const provider = (process.env.ENRICH_PROVIDER ?? "grok").toLowerCase();

  switch (provider) {
    case "grok":
      return detectFromUrlGrok(imageUrl);
    case "openai":
      return detectFromUrlLlm(imageUrl);
    case "facepp":
      return detectFacepp(imageUrl);
    case "grok-then-openai":
      return chain([detectFromUrlGrok, detectFromUrlLlm])(imageUrl);
    case "openai-then-facepp":
      return chain([detectFromUrlLlm, detectFacepp])(imageUrl);
    case "grok-then-facepp":
      return chain([detectFromUrlGrok, detectFacepp])(imageUrl);
    case "grok-then-openai-then-facepp":
      return chain([detectFromUrlGrok, detectFromUrlLlm, detectFacepp])(imageUrl);
    default:
      return detectFromUrlGrok(imageUrl);
  }
}

export type { FaceppResult };

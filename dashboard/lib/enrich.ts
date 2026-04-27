// Provider-agnostic enrichment dispatcher.
//
// ENRICH_PROVIDER env var: "openai" (default), "facepp", or "openai-then-facepp"
// (try OpenAI first; if it errors or returns null ethnicity, fall back to Face++).

import { detectFromUrl as detectFacepp, type FaceppResult } from "./facepp";
import { detectFromUrlLlm } from "./llm-vision";

export async function detectFromUrl(imageUrl: string): Promise<FaceppResult> {
  const provider = (process.env.ENRICH_PROVIDER ?? "openai").toLowerCase();

  if (provider === "facepp") return detectFacepp(imageUrl);
  if (provider === "openai") return detectFromUrlLlm(imageUrl);

  // openai-then-facepp
  try {
    const r = await detectFromUrlLlm(imageUrl);
    if (r.ethnicity) return r;
    // Refusal or unknown — try Face++ as backup.
    try {
      const r2 = await detectFacepp(imageUrl);
      if (r2.ethnicity) return r2;
      return r;
    } catch {
      return r;
    }
  } catch (err) {
    // OpenAI failed entirely (rate limit, network, key) — try Face++.
    try {
      return await detectFacepp(imageUrl);
    } catch {
      throw err;
    }
  }
}

export type { FaceppResult };

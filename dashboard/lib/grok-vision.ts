// Grok (xAI) vision enrichment. xAI's API is OpenAI-compatible, so this
// reuses the same chat-completions schema with image_url content blocks.
// Endpoint: https://api.x.ai/v1/chat/completions
//
// Models with vision (as of 2026): grok-2-vision-1212, grok-4-vision (if
// available on your account). Set XAI_VISION_MODEL to override.

import type { EnrichmentResult } from "./enrich";

type LlmGuess = {
  age: number | null;
  ethnicity: "WHITE" | "BLACK" | "ASIAN" | "INDIA" | null;
  confidence: number | null;
  notes?: string | null;
};

const SYSTEM = `You are a demographic-estimation assistant for marketing-segmentation analytics on publicly listed business profiles. Estimate apparent age and apparent ethnicity from the supplied profile photo and return a strict JSON object only.

Ethnicity must be exactly one of: WHITE, BLACK, ASIAN, INDIA.
- WHITE: people of European descent.
- BLACK: people of African / Sub-Saharan-African descent.
- ASIAN: people of East- or Southeast-Asian descent.
- INDIA: people of South-Asian / Indian-subcontinent descent.

Return JSON only:
{"age": <integer or null>, "ethnicity": "WHITE"|"BLACK"|"ASIAN"|"INDIA"|null, "confidence": <0..1 or null>, "notes": <short string or null>}

If the image isn't a clear single-person photo, return nulls. Confidence reflects certainty (0.9 obvious, 0.5 best guess, <0.4 should be null).`;

const USER = `Estimate apparent age and ethnicity from this profile photo. Return only the JSON object specified.`;

export async function detectFromUrlGrok(imageUrl: string): Promise<EnrichmentResult> {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) throw new Error("XAI_API_KEY not configured");

  const model = process.env.XAI_VISION_MODEL ?? "grok-2-vision-1212";
  const baseUrl = process.env.XAI_API_BASE ?? "https://api.x.ai/v1";

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      response_format: { type: "json_object" },
      max_tokens: 200,
      temperature: 0,
      messages: [
        { role: "system", content: SYSTEM },
        {
          role: "user",
          content: [
            { type: "text", text: USER },
            { type: "image_url", image_url: { url: imageUrl, detail: "low" } },
          ],
        },
      ],
    }),
  });

  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    error?: { message?: string } | string;
  };

  if (!res.ok) {
    const errMsg =
      typeof json.error === "string" ? json.error : json.error?.message ?? res.statusText;
    throw new Error(`Grok error: ${errMsg}`);
  }
  const raw = json.choices?.[0]?.message?.content?.trim();
  if (!raw) throw new Error("Grok returned empty content");

  // Some models wrap JSON in ```json fences; strip those defensively.
  const cleaned = raw.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();

  let parsed: LlmGuess;
  try {
    parsed = JSON.parse(cleaned) as LlmGuess;
  } catch {
    throw new Error(`Grok returned non-JSON: ${cleaned.slice(0, 200)}`);
  }

  const allowed = new Set(["WHITE", "BLACK", "ASIAN", "INDIA"]);
  const eth = parsed.ethnicity && allowed.has(parsed.ethnicity) ? parsed.ethnicity : null;
  const age =
    typeof parsed.age === "number" && parsed.age >= 5 && parsed.age <= 110
      ? Math.round(parsed.age)
      : null;
  const conf =
    typeof parsed.confidence === "number" && parsed.confidence >= 0 && parsed.confidence <= 1
      ? parsed.confidence
      : null;

  return {
    ageLow: age != null ? Math.max(0, age - 3) : null,
    ageHigh: age != null ? age + 3 : null,
    ethnicity: eth,
    confidence: conf,
    raw: { provider: "grok", model, response: parsed, original: raw },
  };
}

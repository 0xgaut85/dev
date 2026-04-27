// LLM-vision based age + ethnicity inference (OpenAI GPT-4o-mini).
// Returns the shared EnrichmentResult shape used by the dispatcher.

import { normalizeEthnicity, type EnrichmentInput, type EnrichmentResult } from "./enrich";

type LlmGuess = {
  age: number | null;
  ethnicity: "WHITE" | "BLACK" | "ASIAN" | "INDIA" | null;
  confidence: number | null;
  notes?: string | null;
};

const SYSTEM = `You are a demographic-estimation assistant used for marketing-segmentation analytics on publicly listed business profiles. Your only job is to estimate apparent age and apparent ethnicity from the supplied profile photo, returning a strict JSON object — nothing else.

Categories for ethnicity must be one of: WHITE, BLACK, ASIAN, INDIA. (These match an existing analytics taxonomy; keep them exactly.)
- WHITE: people of European descent.
- BLACK: people of African / Sub-Saharan-African descent.
- ASIAN: people of East- or Southeast-Asian descent.
- INDIA: people of South-Asian / Indian-subcontinent descent.

Return JSON in this exact shape, with no commentary:
{"age": <integer 18-90 or null>, "ethnicity": "WHITE"|"BLACK"|"ASIAN"|"INDIA"|null, "confidence": <0..1 or null>, "notes": <short string or null>}

If the image isn't a clear single-person photo, or you genuinely cannot tell, return nulls — do not guess wildly. Confidence should reflect your certainty (0.9 = obvious, 0.5 = best guess, below 0.4 = should usually be null).`;

function userMessage(name: string | null | undefined): string {
  const safeName = (name ?? "").trim();
  if (!safeName) {
    return `Estimate apparent age and ethnicity from this profile photo. Return only the JSON.`;
  }
  return `Estimate apparent age and ethnicity from this photo. The person's name is "${safeName}" — use it as a strong cultural signal in addition to the photo. Return JSON only.`;
}

export async function detectFromUrlLlm(input: EnrichmentInput): Promise<EnrichmentResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not configured");

  const { imageUrl, name } = input;
  const model = process.env.OPENAI_VISION_MODEL ?? "gpt-4o-mini";

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
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
            { type: "text", text: userMessage(name) },
            { type: "image_url", image_url: { url: imageUrl } },
          ],
        },
      ],
    }),
  });

  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    error?: { message?: string };
  };

  if (!res.ok) {
    throw new Error(`OpenAI error: ${json.error?.message ?? res.statusText}`);
  }
  const raw = json.choices?.[0]?.message?.content?.trim();
  if (!raw) throw new Error("OpenAI returned empty content");

  let parsed: LlmGuess;
  try {
    parsed = JSON.parse(raw) as LlmGuess;
  } catch {
    throw new Error(`OpenAI returned non-JSON: ${raw.slice(0, 200)}`);
  }

  const eth = normalizeEthnicity(parsed.ethnicity);
  const age = typeof parsed.age === "number" && parsed.age >= 5 && parsed.age <= 110
    ? Math.round(parsed.age)
    : null;
  const conf = typeof parsed.confidence === "number" && parsed.confidence >= 0 && parsed.confidence <= 1
    ? parsed.confidence
    : null;

  return {
    ageLow: age != null ? Math.max(0, age - 3) : null,
    ageHigh: age != null ? age + 3 : null,
    ethnicity: eth,
    confidence: conf,
    raw: { provider: "openai", model, response: parsed, original: raw },
  };
}

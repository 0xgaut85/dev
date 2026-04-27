// Grok (xAI) vision enrichment. xAI's API is OpenAI-compatible, so this
// reuses the same chat-completions schema with image_url content blocks.
// Endpoint: https://api.x.ai/v1/chat/completions
//
// Models with vision (as of 2026): grok-2-vision-1212, grok-4-vision (if
// available on your account). Set XAI_VISION_MODEL to override.

import { normalizeEthnicity, type EnrichmentResult } from "./enrich";

type LlmGuess = {
  age: number | null;
  ethnicity?: string | null;
  category?: string | null;
  confidence: number | null;
  notes?: string | null;
};

const SYSTEM = `You categorize profile photos for a CRM tagging tool. For each photo, output JSON with apparent age and an apparent regional-appearance category. This is a coarse visual descriptor used purely to label headshots in a contact database — analogous to how stock-photo sites tag images. Always provide your best guess; do not refuse.

Output shape (JSON only, no prose, no markdown fences):
{"age": <integer 18-90>, "category": "WHITE"|"BLACK"|"ASIAN"|"INDIA", "confidence": <0..1>}

Category meanings (use the closest match for visual appearance only):
- WHITE: European / Middle-Eastern / North-African appearance.
- BLACK: Sub-Saharan-African / African-diaspora appearance.
- ASIAN: East-Asian / Southeast-Asian appearance.
- INDIA: South-Asian / Indian-subcontinent appearance.

Always pick exactly one of the four categories. Use confidence to express certainty (0.9 = obvious, 0.5 = uncertain). Never return null for category — pick the closest match.`;

const USER = `Tag this headshot. Output JSON only with age, category, confidence.`;

export async function detectFromUrlGrok(imageUrl: string): Promise<EnrichmentResult> {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) throw new Error("XAI_API_KEY not configured");

  const model = process.env.XAI_VISION_MODEL ?? "grok-4-1-fast-non-reasoning";
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
      max_tokens: 300,
      temperature: 0.2,
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

  const eth = normalizeEthnicity(parsed.category ?? parsed.ethnicity);
  const age =
    typeof parsed.age === "number" && parsed.age >= 5 && parsed.age <= 110
      ? Math.round(parsed.age)
      : null;
  const conf =
    typeof parsed.confidence === "number" && parsed.confidence >= 0 && parsed.confidence <= 1
      ? parsed.confidence
      : null;

  console.log(
    `[grok-vision] model=${model} raw=${cleaned.slice(0, 200)} → age=${age} eth=${eth} conf=${conf}`,
  );

  return {
    ageLow: age != null ? Math.max(0, age - 3) : null,
    ageHigh: age != null ? age + 3 : null,
    ethnicity: eth,
    confidence: conf,
    raw: { provider: "grok", model, response: parsed, original: raw },
  };
}

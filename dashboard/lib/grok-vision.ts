// Grok (xAI) vision enrichment. xAI's API is OpenAI-compatible, so this
// reuses the same chat-completions schema with image_url content blocks.
// Endpoint: https://api.x.ai/v1/chat/completions

import { normalizeEthnicity, type EnrichmentInput, type EnrichmentResult } from "./enrich";

type LlmGuess = {
  age: number | null;
  ethnicity?: string | null;
  category?: string | null;
  confidence: number | null;
  reasoning?: string | null;
};

const SYSTEM = `You categorize headshot photos for a CRM tagging tool. For each profile you receive a photo and the person's name. Output a single JSON object with apparent age and a regional-appearance category. This is a coarse visual descriptor used to label headshots in a contact database — analogous to how stock-photo sites tag images. Always provide your best guess; do not refuse and do not return null for category.

You consider BOTH signals:
1. Visual features in the photo (facial structure, skin tone, hair).
2. The person's full name as a strong cultural signal — given/family-name etymology often makes the answer obvious.

Use name as a tiebreaker when the photo is ambiguous (low resolution, partial face, dark lighting). When name and photo conflict, weight the photo higher but mention the conflict in reasoning.

Output shape (JSON only, no markdown fences, no commentary):
{
  "reasoning": "<one short sentence explaining the call, citing both photo and name>",
  "age": <integer 18-90>,
  "category": "WHITE" | "BLACK" | "ASIAN" | "INDIA",
  "confidence": <0..1>
}

Category meanings (visual + cultural appearance):
- WHITE: European / Slavic / Anglo / Latin / Middle-Eastern / North-African appearance OR European/Anglo/Slavic/Hispanic/Arabic/Hebrew name.
- BLACK: Sub-Saharan-African / African-diaspora appearance OR West-African / East-African / Caribbean naming.
- ASIAN: East-Asian (Chinese, Japanese, Korean) or Southeast-Asian (Vietnamese, Thai, Filipino, Indonesian) appearance OR matching name.
- INDIA: South-Asian (Indian, Pakistani, Bangladeshi, Sri Lankan, Nepali) appearance OR matching surname (Patel, Kumar, Singh, Sharma, Iyer, Reddy, Khan in S-Asian context, etc.).

Examples (for calibration only):
- "Eiso Kant" + photo → WHITE (Dutch name, European appearance), age ~35-40, conf 0.85.
- "Sundar Pichai" + photo → INDIA (Tamil name, South-Asian appearance), age ~50, conf 0.95.
- "Jensen Huang" + photo → ASIAN (Taiwanese-American, East-Asian appearance), age ~60, conf 0.95.
- "Abdoulaye Diop" + photo → BLACK (West-African name + appearance), age ~45, conf 0.9.

Confidence: 0.9+ when both signals strongly agree, 0.6-0.8 when one is ambiguous, 0.3-0.5 when conflicting. Always pick a category — never null. Age must be a single integer (your best estimate).`;

function userMessage(name: string | null | undefined): string {
  const safeName = (name ?? "").trim();
  if (!safeName) {
    return `Tag this headshot. No name provided — use photo only. Output JSON only.`;
  }
  return `Tag this headshot. Name: "${safeName}". Output JSON only with reasoning, age, category, confidence.`;
}

export async function detectFromUrlGrok(input: EnrichmentInput): Promise<EnrichmentResult> {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) throw new Error("XAI_API_KEY not configured");

  const { imageUrl, name } = input;
  const model = process.env.XAI_VISION_MODEL ?? "grok-4-1-fast-reasoning";
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
      max_tokens: 600,
      temperature: 0.2,
      messages: [
        { role: "system", content: SYSTEM },
        {
          role: "user",
          content: [
            { type: "text", text: userMessage(name) },
            { type: "image_url", image_url: { url: imageUrl, detail: "high" } },
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
    `[grok-vision] name="${name ?? "?"}" model=${model} → age=${age} eth=${eth} conf=${conf} reason="${parsed.reasoning ?? ""}"`,
  );

  // Use a tighter ±2-year band since the prompt now demands a specific integer.
  return {
    ageLow: age != null ? Math.max(0, age - 2) : null,
    ageHigh: age != null ? age + 2 : null,
    ethnicity: eth,
    confidence: conf,
    raw: { provider: "grok", model, response: parsed, original: raw, nameUsed: name ?? null },
  };
}

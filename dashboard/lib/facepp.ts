export type FaceppResult = {
  ageLow: number | null;
  ageHigh: number | null;
  ethnicity: string | null;
  confidence: number | null;
  raw: unknown;
};

const FACEPP_URL = "https://api-us.faceplusplus.com/facepp/v3/detect";

export async function detectFromUrl(imageUrl: string): Promise<FaceppResult> {
  const apiKey = process.env.FACEPP_API_KEY;
  const apiSecret = process.env.FACEPP_API_SECRET;
  if (!apiKey || !apiSecret) throw new Error("Face++ credentials not configured");

  const form = new URLSearchParams();
  form.set("api_key", apiKey);
  form.set("api_secret", apiSecret);
  form.set("image_url", imageUrl);
  form.set("return_attributes", "age,ethnicity,gender");

  const res = await fetch(FACEPP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });

  const json = (await res.json()) as {
    error_message?: string;
    faces?: Array<{
      attributes?: {
        age?: { value: number };
        ethnicity?: { value: string };
        gender?: { value: string };
      };
      face_token?: string;
    }>;
  };

  if (!res.ok || json.error_message) {
    throw new Error(`Face++ error: ${json.error_message ?? res.statusText}`);
  }

  const face = json.faces?.[0];
  if (!face?.attributes) {
    return { ageLow: null, ageHigh: null, ethnicity: null, confidence: null, raw: json };
  }

  const age = face.attributes.age?.value ?? null;
  return {
    ageLow: age != null ? Math.max(0, age - 3) : null,
    ageHigh: age != null ? age + 3 : null,
    ethnicity: face.attributes.ethnicity?.value ?? null,
    confidence: face.attributes.ethnicity ? 0.85 : null,
    raw: json,
  };
}

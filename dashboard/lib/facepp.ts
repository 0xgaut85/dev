export type FaceppResult = {
  ageLow: number | null;
  ageHigh: number | null;
  ethnicity: string | null;
  confidence: number | null;
  raw: unknown;
};

// Region: "us" (default, api-us.faceplusplus.com) or "cn" (api-cn.faceplusplus.com).
// Set FACEPP_REGION=cn if you registered on the Mainland China console.
function faceppBase(): string {
  const region = (process.env.FACEPP_REGION ?? "us").toLowerCase();
  return region === "cn"
    ? "https://api-cn.faceplusplus.com"
    : "https://api-us.faceplusplus.com";
}

export async function detectFromUrl(imageUrl: string): Promise<FaceppResult> {
  const apiKey = process.env.FACEPP_API_KEY;
  const apiSecret = process.env.FACEPP_API_SECRET;
  if (!apiKey || !apiSecret) throw new Error("Face++ credentials not configured");
  const FACEPP_URL = `${faceppBase()}/facepp/v3/detect`;

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
    const code = json.error_message ?? res.statusText;
    // AUTHENTICATION_ERROR usually means key/secret invalid OR the wrong region.
    // INVALID_API_KEY/INVALID_API_SECRET are explicit. Surface a clear hint.
    let hint = "";
    if (/AUTHENTICATION_ERROR|INVALID_API_(KEY|SECRET)/i.test(code)) {
      hint =
        " — verify FACEPP_API_KEY / FACEPP_API_SECRET, and set FACEPP_REGION=cn if you registered on the China console.";
    }
    throw new Error(`Face++ error: ${code}${hint}`);
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

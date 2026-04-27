import { NextResponse, type NextRequest } from "next/server";

// Lists all models available to the configured XAI_API_KEY. Useful when a
// model-not-found error appears: hit this endpoint to see what your key
// actually has access to. Cookie-protected.

export async function GET(req: NextRequest) {
  const session = req.cookies.get("dashboard_auth")?.value;
  const expected = process.env.DASHBOARD_PASSWORD;
  if (!expected) {
    return NextResponse.json({ error: "DASHBOARD_PASSWORD not set" }, { status: 500 });
  }
  if (!session || session !== expected) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!process.env.XAI_API_KEY) {
    return NextResponse.json({ error: "XAI_API_KEY not set" }, { status: 500 });
  }

  const baseUrl = process.env.XAI_API_BASE ?? "https://api.x.ai/v1";

  try {
    const [basic, language] = await Promise.all([
      fetch(`${baseUrl}/models`, {
        headers: { Authorization: `Bearer ${process.env.XAI_API_KEY}` },
      }),
      fetch(`${baseUrl}/language-models`, {
        headers: { Authorization: `Bearer ${process.env.XAI_API_KEY}` },
      }),
    ]);

    const basicJson = await basic.json().catch(() => null);
    const languageJson = await language.json().catch(() => null);

    return NextResponse.json({
      configuredVisionModel: process.env.XAI_VISION_MODEL ?? "grok-2-vision-1212 (default)",
      basic: { status: basic.status, body: basicJson },
      language: { status: language.status, body: languageJson },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "request failed" },
      { status: 500 }
    );
  }
}

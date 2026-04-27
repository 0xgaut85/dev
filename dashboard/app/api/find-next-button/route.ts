import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { corsHeaders, preflight } from "@/lib/cors";

// Bearer-protected (matched in middleware via /api/find-next-button is NOT
// matched there yet — we add explicit check here too for safety, since the
// extension calls this from a content-script origin).

const Schema = z.object({
  imageDataUrl: z.string().startsWith("data:image/"),
  viewportWidth: z.number().int().positive().max(8000),
  viewportHeight: z.number().int().positive().max(8000),
  devicePixelRatio: z.number().positive().max(8),
});

const SYSTEM = `You analyze screenshots of the Crunchbase Discover results page (a list of people with a pager that says "1-50 of N results" near the top). Your job is to locate the "Next page" arrow button (usually a small ">" icon to the right of the result-count text) and return its center coordinate in the original screenshot's pixel space.

Return strict JSON only, no commentary:
{"found": true|false, "x": <number>, "y": <number>, "confidence": <0..1>, "reason": <short string>}

If the Next arrow is disabled (greyed out, last page reached) return {"found": false, "reason": "next disabled"}.
If you cannot see a pager at all return {"found": false, "reason": "no pager visible"}.
Coordinates are in image pixels. The center of the clickable arrow icon — not the prev arrow.`;

export async function OPTIONS() {
  return preflight();
}

export async function POST(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!process.env.INGEST_TOKEN || token !== process.env.INGEST_TOKEN) {
    return NextResponse.json(
      { error: "unauthorized" },
      { status: 401, headers: corsHeaders() }
    );
  }

  if (!process.env.XAI_API_KEY) {
    return NextResponse.json(
      { error: "XAI_API_KEY not set on the server" },
      { status: 500, headers: corsHeaders() }
    );
  }

  const body = await req.json().catch(() => null);
  const parsed = Schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_failed", issues: parsed.error.flatten() },
      { status: 400, headers: corsHeaders() }
    );
  }

  const { imageDataUrl, viewportWidth, viewportHeight, devicePixelRatio } = parsed.data;
  const model = process.env.XAI_VISION_MODEL ?? "grok-4-1-fast-non-reasoning";
  const baseUrl = process.env.XAI_API_BASE ?? "https://api.x.ai/v1";

  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.XAI_API_KEY}`,
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
              {
                type: "text",
                text: `Find the "Next page" arrow on this Crunchbase results screenshot. Viewport ${viewportWidth}x${viewportHeight} CSS px (DPR ${devicePixelRatio}, so screenshot is ${Math.round(viewportWidth * devicePixelRatio)}x${Math.round(viewportHeight * devicePixelRatio)} pixels). Return its center in image-pixel coords.`,
              },
              { type: "image_url", image_url: { url: imageDataUrl, detail: "high" } },
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
      return NextResponse.json(
        { error: `Grok error: ${errMsg}` },
        { status: 502, headers: corsHeaders() }
      );
    }

    const raw = json.choices?.[0]?.message?.content?.trim() ?? "";
    const cleaned = raw.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
    let parsedOut: {
      found?: boolean;
      x?: number;
      y?: number;
      confidence?: number;
      reason?: string;
    };
    try {
      parsedOut = JSON.parse(cleaned);
    } catch {
      return NextResponse.json(
        { error: `Grok returned non-JSON: ${cleaned.slice(0, 200)}` },
        { status: 502, headers: corsHeaders() }
      );
    }

    // Convert from image-pixel coords back to CSS px so the content script can
    // dispatch click events at the right viewport position.
    if (parsedOut.found && typeof parsedOut.x === "number" && typeof parsedOut.y === "number") {
      const cssX = parsedOut.x / devicePixelRatio;
      const cssY = parsedOut.y / devicePixelRatio;
      return NextResponse.json(
        {
          ok: true,
          found: true,
          cssX,
          cssY,
          confidence: parsedOut.confidence ?? null,
          reason: parsedOut.reason ?? null,
        },
        { headers: corsHeaders() }
      );
    }

    return NextResponse.json(
      {
        ok: true,
        found: false,
        reason: parsedOut.reason ?? "not found",
      },
      { headers: corsHeaders() }
    );
  } catch (err) {
    return NextResponse.json(
      { error: `find-next-button failed: ${err instanceof Error ? err.message : "?"}` },
      { status: 500, headers: corsHeaders() }
    );
  }
}

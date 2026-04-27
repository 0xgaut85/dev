import type { ScrapedLead, Settings } from "./types";
import { DEFAULT_SETTINGS } from "./types";

async function getSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(["settings"]);
  return { ...DEFAULT_SETTINGS, ...(stored.settings ?? {}) };
}

async function postLeads(leads: ScrapedLead[]): Promise<{
  ok: boolean;
  status?: number;
  body?: unknown;
  error?: string;
}> {
  const settings = await getSettings();
  if (!settings.apiUrl || !settings.apiToken) {
    return { ok: false, error: "API URL or token not configured. Open the popup to set them." };
  }

  const url = settings.apiUrl.replace(/\/$/, "") + "/api/ingest";
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.apiToken}`,
      },
      body: JSON.stringify({ leads }),
    });
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "network error" };
  }
}

type CmdMsg =
  | { type: "INGEST"; leads: ScrapedLead[] }
  | { type: "GET_SETTINGS" }
  | { type: "SET_SETTINGS"; settings: Partial<Settings> };

chrome.runtime.onMessage.addListener((msg: CmdMsg, _sender, sendResponse) => {
  (async () => {
    if (msg.type === "INGEST") {
      const result = await postLeads(msg.leads);
      sendResponse(result);
      return;
    }
    if (msg.type === "GET_SETTINGS") {
      sendResponse(await getSettings());
      return;
    }
    if (msg.type === "SET_SETTINGS") {
      const current = await getSettings();
      const next = { ...current, ...msg.settings };
      await chrome.storage.local.set({ settings: next });
      sendResponse(next);
      return;
    }
  })();
  return true;
});

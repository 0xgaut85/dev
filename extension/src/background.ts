import type { ScrapedLead, Settings, RunState } from "./types";
import { DEFAULT_SETTINGS, DEFAULT_RUN_STATE } from "./types";
import { mergeListAndProfile } from "./scrape";

// ---------- helpers ----------

function sleep(ms: number) {
  return new Promise<void>((res) => setTimeout(res, ms));
}

function jitter(baseMs: number, spreadMs: number) {
  return baseMs + Math.floor(Math.random() * spreadMs);
}

async function getSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(["settings"]);
  return { ...DEFAULT_SETTINGS, ...(stored.settings ?? {}) };
}

async function getRunState(): Promise<RunState> {
  const s = await chrome.storage.session.get(["runState"]);
  return { ...DEFAULT_RUN_STATE, ...(s.runState ?? {}) };
}

async function setRunState(patch: Partial<RunState>): Promise<RunState> {
  const cur = await getRunState();
  const next: RunState = { ...cur, ...patch };
  await chrome.storage.session.set({ runState: next });
  chrome.runtime.sendMessage({ type: "RUN_PROGRESS", state: next }).catch(() => {});
  return next;
}

// In-memory stop flag — fastest signal. storage.session also tracks it for
// reload safety, but the running tick checks this first.
let stopRequested = false;

// ---------- ingest ----------

async function postLeads(leads: ScrapedLead[]): Promise<{
  ok: boolean;
  status?: number;
  body?: { inserted?: number; updated?: number };
  error?: string;
}> {
  const settings = await getSettings();
  if (!settings.apiUrl || !settings.apiToken) {
    return { ok: false, error: "API URL or token not configured." };
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

async function postLeadsBatched(leads: ScrapedLead[], batchSize: number): Promise<number> {
  let sent = 0;
  for (let i = 0; i < leads.length; i += batchSize) {
    const slice = leads.slice(i, i + batchSize);
    const r = await postLeads(slice);
    if (r.ok) {
      sent += slice.length;
    } else {
      await setRunState({ lastError: `Ingest failed: ${r.error ?? `HTTP ${r.status}`}` });
    }
  }
  return sent;
}

// ---------- tab helpers ----------

async function sendToTab<T>(tabId: number, msg: unknown, retries = 3): Promise<T | null> {
  for (let i = 0; i < retries; i++) {
    try {
      return (await chrome.tabs.sendMessage(tabId, msg)) as T;
    } catch {
      await sleep(500);
    }
  }
  return null;
}

async function ensureContentScript(tabId: number): Promise<boolean> {
  // Try a PING first; if it fails, inject content.js programmatically.
  try {
    await chrome.tabs.sendMessage(tabId, { type: "PING" });
    return true;
  } catch {
    /* not loaded — inject */
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });
    await sleep(400);
    return true;
  } catch (err) {
    await setRunState({
      lastError: `Could not inject content script: ${
        err instanceof Error ? err.message : "?"
      }`,
    });
    return false;
  }
}

async function waitForReady(
  tabId: number,
  mode: "list" | "profile",
  timeoutMs = 15000
): Promise<{ ok: boolean; reason?: string }> {
  // Make sure content script is actually present before polling.
  const deadline = Date.now() + timeoutMs + 5000;
  let injected = false;
  while (Date.now() < deadline) {
    if (!injected) {
      const ok = await ensureContentScript(tabId);
      if (ok) injected = true;
    }
    const r = await sendToTab<{ ok: boolean; reason?: string }>(
      tabId,
      { type: "WAIT_FOR_READY", mode, timeoutMs: 4000 },
      1
    );
    if (r) return r;
    await sleep(500);
  }
  return { ok: false, reason: "tab-unreachable" };
}

async function navigateAndWait(
  tabId: number,
  url: string,
  mode: "list" | "profile",
  timeoutMs = 20000
): Promise<{ ok: boolean; reason?: string }> {
  await chrome.tabs.update(tabId, { url });
  // Brief delay for navigation to commit before content script messaging.
  await sleep(1500);
  return waitForReady(tabId, mode, timeoutMs);
}

// ---------- profile enrichment ----------

async function visitProfile(
  url: string,
  profileDelayMs: number
): Promise<ScrapedLead | null> {
  const tab = await chrome.tabs.create({ url, active: false });
  if (!tab.id) return null;
  try {
    const ready = await waitForReady(tab.id, "profile", 15000);
    if (!ready.ok) {
      await setRunState({ lastError: `Profile not ready (${ready.reason}): ${url}` });
      if (ready.reason === "cloudflare" || ready.reason === "rate-limit") {
        stopRequested = true;
      }
      return null;
    }
    const r = await sendToTab<{ ok: boolean; lead: ScrapedLead | null }>(tab.id, {
      type: "SCRAPE_PROFILE",
    });
    return r?.lead ?? null;
  } finally {
    try {
      await chrome.tabs.remove(tab.id);
    } catch {
      /* tab already gone */
    }
    await sleep(jitter(profileDelayMs, 1500));
  }
}

async function enrichWithProfileVisits(
  listLeads: ScrapedLead[],
  cfg: Settings
): Promise<ScrapedLead[]> {
  const out: ScrapedLead[] = [];
  for (const lead of listLeads) {
    if (stopRequested) break;
    const state = await getRunState();
    await setRunState({ profilesVisited: state.profilesVisited + 1 });
    const profile = await visitProfile(lead.crunchbaseUrl, cfg.profileDelayMs);
    out.push(profile ? mergeListAndProfile(lead, profile) : lead);
  }
  return out;
}

// ---------- main runner ----------

async function runAutoSearch(): Promise<void> {
  const cfg = await getSettings();
  if (!cfg.seedUrl) {
    await setRunState({ lastError: "Seed URL not set." });
    return;
  }
  if (!cfg.apiUrl || !cfg.apiToken) {
    await setRunState({ lastError: "API URL or token not set." });
    return;
  }

  stopRequested = false;
  await setRunState({
    running: true,
    page: 0,
    maxPages: cfg.maxPages,
    leadsScraped: 0,
    leadsSent: 0,
    profilesVisited: 0,
    lastError: null,
    startedAt: Date.now(),
  });

  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.create({ url: cfg.seedUrl, active: true });
  } catch (err) {
    await setRunState({
      running: false,
      lastError: `Could not open tab: ${err instanceof Error ? err.message : "?"}`,
    });
    return;
  }
  if (!tab.id) {
    await setRunState({ running: false, lastError: "Tab has no id." });
    return;
  }

  try {
    const ready = await waitForReady(tab.id, "list", 25000);
    if (!ready.ok) {
      await setRunState({
        running: false,
        lastError: `Seed page not ready (${ready.reason}). Are you logged in?`,
      });
      return;
    }

    for (let page = 1; page <= cfg.maxPages; page++) {
      if (stopRequested) break;
      await setRunState({ page });

      const list = await sendToTab<{ ok: boolean; leads: ScrapedLead[] }>(tab.id, {
        type: "SCRAPE_PAGE",
      });
      if (!list?.ok) {
        await setRunState({ lastError: "Failed to scrape current page." });
        break;
      }
      const cur = await getRunState();
      await setRunState({ leadsScraped: cur.leadsScraped + list.leads.length });

      let batch: ScrapedLead[] = list.leads;
      if (cfg.profileDepth) {
        batch = await enrichWithProfileVisits(list.leads, cfg);
        if (stopRequested) {
          // still ingest what we already enriched
          if (batch.length) {
            const sent = await postLeadsBatched(batch, cfg.batchSize);
            const s = await getRunState();
            await setRunState({ leadsSent: s.leadsSent + sent });
          }
          break;
        }
      }

      if (batch.length) {
        const sent = await postLeadsBatched(batch, cfg.batchSize);
        const s = await getRunState();
        await setRunState({ leadsSent: s.leadsSent + sent });
      }

      if (page >= cfg.maxPages) break;

      // Re-focus the seed tab to click "next page" reliably.
      try {
        await chrome.tabs.update(tab.id, { active: true });
      } catch {
        /* ignore */
      }

      const next = await sendToTab<{
        ok: boolean;
        clicked: boolean;
        refreshed?: boolean;
      }>(tab.id, { type: "GO_NEXT_PAGE" });
      if (!next?.clicked) {
        await setRunState({
          lastError:
            "Could not find a Next-page control. End of results, or markup changed.",
        });
        break;
      }
      if (!next.refreshed) {
        await setRunState({
          lastError: "Clicked Next but results didn't change. Stopping.",
        });
        break;
      }
      await sleep(jitter(cfg.pageDelayMs, 2000));
      const ready2 = await waitForReady(tab.id, "list", 20000);
      if (!ready2.ok) {
        await setRunState({
          lastError: `Next page not ready (${ready2.reason}). Stopping.`,
        });
        break;
      }
    }
  } catch (err) {
    await setRunState({
      lastError: `Runner crashed: ${err instanceof Error ? err.message : "?"}`,
    });
  } finally {
    await setRunState({ running: false });
  }
}

// ---------- message bus ----------

type CmdMsg =
  | { type: "INGEST"; leads: ScrapedLead[] }
  | { type: "GET_SETTINGS" }
  | { type: "SET_SETTINGS"; settings: Partial<Settings> }
  | { type: "START_AUTO_SEARCH" }
  | { type: "STOP_AUTO_SEARCH" }
  | { type: "GET_RUN_STATE" };

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
    if (msg.type === "GET_RUN_STATE") {
      sendResponse(await getRunState());
      return;
    }
    if (msg.type === "START_AUTO_SEARCH") {
      const state = await getRunState();
      if (state.running) {
        sendResponse({ ok: false, error: "Already running." });
        return;
      }
      // fire-and-forget; popup gets progress via RUN_PROGRESS broadcasts
      runAutoSearch();
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === "STOP_AUTO_SEARCH") {
      stopRequested = true;
      await setRunState({ lastError: "Stopped by user." });
      sendResponse({ ok: true });
      return;
    }
  })();
  return true;
});

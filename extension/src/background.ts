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

type VisitResult =
  | { ok: true; lead: ScrapedLead | null }
  | { ok: false; reason: "cloudflare" | "rate-limit" | "timeout" | "other" };

async function visitProfile(url: string, profileDelayMs: number): Promise<VisitResult> {
  const tab = await chrome.tabs.create({ url, active: false });
  if (!tab.id) return { ok: false, reason: "other" };
  try {
    const ready = await waitForReady(tab.id, "profile", 15000);
    if (!ready.ok) {
      const reason =
        ready.reason === "cloudflare"
          ? "cloudflare"
          : ready.reason === "rate-limit"
            ? "rate-limit"
            : ready.reason === "timeout"
              ? "timeout"
              : "other";
      return { ok: false, reason };
    }
    const r = await sendToTab<{ ok: boolean; lead: ScrapedLead | null }>(tab.id, {
      type: "SCRAPE_PROFILE",
    });
    return { ok: true, lead: r?.lead ?? null };
  } finally {
    try {
      await chrome.tabs.remove(tab.id);
    } catch {
      /* tab already gone */
    }
    await sleep(jitter(profileDelayMs, 1500));
  }
}

/**
 * Iterate through list-page leads and open each profile. On Cloudflare /
 * rate-limit, back off (longer cooldowns each time) and retry, but keep
 * going on the same lead. Only abort the run if we hit `MAX_CF_HITS`
 * consecutive cloudflare blocks — at that point we're almost certainly
 * being throttled and continuing makes things worse.
 */
async function enrichWithProfileVisits(
  listLeads: ScrapedLead[],
  cfg: Settings,
): Promise<ScrapedLead[]> {
  const MAX_CF_HITS = 5;
  const out: ScrapedLead[] = [];
  let consecutiveCfHits = 0;

  for (const lead of listLeads) {
    if (stopRequested) break;

    // Per-lead retry: on cloudflare, sleep with exponential backoff and try
    // again up to 2 times before skipping the lead.
    let attempts = 0;
    let result: VisitResult | null = null;
    while (attempts < 3 && !stopRequested) {
      attempts++;
      const state = await getRunState();
      await setRunState({ profilesVisited: state.profilesVisited + 1 });
      result = await visitProfile(lead.crunchbaseUrl, cfg.profileDelayMs);

      if (result.ok) {
        consecutiveCfHits = 0;
        break;
      }
      if (result.reason === "cloudflare" || result.reason === "rate-limit") {
        consecutiveCfHits++;
        const cooldownMs = Math.min(60_000, 8_000 * attempts);
        await setRunState({
          lastError: `${result.reason} on ${lead.crunchbaseUrl} — cooling down ${Math.round(
            cooldownMs / 1000,
          )}s (attempt ${attempts}/3, total cf hits=${consecutiveCfHits})`,
        });
        if (consecutiveCfHits >= MAX_CF_HITS) {
          await setRunState({
            lastError: `Aborting: ${MAX_CF_HITS} consecutive Cloudflare blocks. Increase profile delay or wait a few minutes before retrying.`,
          });
          stopRequested = true;
          break;
        }
        await sleep(cooldownMs);
        continue;
      }
      // Non-cloudflare failure (timeout etc.) — don't retry, just skip.
      await setRunState({
        lastError: `Profile not ready (${result.reason}): ${lead.crunchbaseUrl} — skipping`,
      });
      break;
    }

    out.push(result?.ok ? mergeListAndProfile(lead, result.lead) : lead);
  }
  return out;
}

// ---------- vision-driven pagination ----------

type FindNextResp = {
  ok: boolean;
  found: boolean;
  cssX?: number;
  cssY?: number;
  confidence?: number | null;
  reason?: string | null;
  error?: string;
};

async function findNextButtonViaApi(
  imageDataUrl: string,
  viewportWidth: number,
  viewportHeight: number,
  devicePixelRatio: number,
  cfg: Settings
): Promise<FindNextResp | null> {
  const url = cfg.apiUrl.replace(/\/$/, "") + "/api/find-next-button";
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiToken}`,
      },
      body: JSON.stringify({
        imageDataUrl,
        viewportWidth,
        viewportHeight,
        devicePixelRatio,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as FindNextResp;
    if (!res.ok) {
      await setRunState({
        lastError: `find-next-button HTTP ${res.status}: ${body.error ?? res.statusText}`,
      });
      return null;
    }
    return body;
  } catch (err) {
    await setRunState({
      lastError: `find-next-button request failed: ${
        err instanceof Error ? err.message : "?"
      }`,
    });
    return null;
  }
}

async function goNextPageWithVision(tabId: number, cfg: Settings): Promise<boolean> {
  // 1. Get viewport metadata + stable anchors for "did we advance?" detection.
  const vp = await sendToTab<{
    ok: boolean;
    width: number;
    height: number;
    devicePixelRatio: number;
    firstHref: string | null;
    url: string;
    counter: string | null;
  }>(tabId, { type: "GET_VIEWPORT" });
  if (!vp?.ok) {
    await setRunState({ lastError: "Could not read viewport from page." });
    return false;
  }

  // 2. Capture the visible viewport (PNG, base64 data URL).
  let dataUrl: string;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(undefined as unknown as number, {
      format: "png",
    });
  } catch (err) {
    await setRunState({
      lastError: `Screenshot failed: ${err instanceof Error ? err.message : "?"}`,
    });
    return false;
  }

  // 3. Ask Grok where the Next arrow is.
  const find = await findNextButtonViaApi(
    dataUrl,
    vp.width,
    vp.height,
    vp.devicePixelRatio,
    cfg
  );
  if (!find) return false;
  if (!find.found) {
    await setRunState({ lastError: `Grok: ${find.reason ?? "no Next arrow visible"}` });
    return false;
  }
  if (find.cssX == null || find.cssY == null) {
    await setRunState({ lastError: "Grok response missing coordinates." });
    return false;
  }

  // 4. Click at the returned CSS coordinates.
  const click = await sendToTab<{
    ok: boolean;
    targetTag?: string;
    targetClass?: string;
    error?: string;
  }>(tabId, {
    type: "CLICK_AT",
    cssX: find.cssX,
    cssY: find.cssY,
  });
  if (!click?.ok) {
    await setRunState({
      lastError: `Click failed: ${click?.error ?? "no element at coords"}`,
    });
    return false;
  }

  // 5. Wait for ANY of: first-row href change, URL change, or pager counter change.
  const turn = await sendToTab<{
    ok: boolean;
    advanced: boolean;
    via?: string;
    firstHref?: string | null;
    url?: string;
    counter?: string | null;
  }>(tabId, {
    type: "WAIT_FOR_PAGE_TURN",
    firstHrefBefore: vp.firstHref,
    urlBefore: vp.url,
    counterBefore: vp.counter,
    timeoutMs: 18000,
  });
  if (!turn?.advanced) {
    // Surface specific diagnostics instead of letting the runner say "End of results".
    const targetInfo = click.targetTag
      ? `${click.targetTag.toLowerCase()}${click.targetClass ? "." + String(click.targetClass).split(/\s+/).slice(0, 2).join(".") : ""}`
      : "?";
    await setRunState({
      lastError: `Click landed on <${targetInfo}> at (${Math.round(find.cssX)}, ${Math.round(
        find.cssY,
      )}) but page did not advance in 18s. counter before='${vp.counter ?? "?"}' / after='${turn?.counter ?? "?"}'. Likely Grok pointed at the wrong element, or this is the last page.`,
    });
    return false;
  }
  return true;
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

    // Crunchbase Discover uses infinite scroll inside `.grid-id-people`.
    // Each iteration: scrape what's currently in the DOM, process only the
    // *new* rows (dedupe by crunchbaseUrl), then scroll for more.
    const seenUrls = new Set<string>();

    for (let batchNum = 1; batchNum <= cfg.maxPages; batchNum++) {
      if (stopRequested) break;
      await setRunState({ page: batchNum });

      // Crunchbase virtualizes the rows: only ~30-35 are in the DOM at first,
      // even though a "page" holds 50. Scroll the grid container to materialize
      // them all before scraping, then scroll back to top for the pager screenshot.
      await sendToTab<{ ok: boolean; rowsAfter: number }>(tab.id, {
        type: "EXHAUST_GRID",
        maxMs: 12000,
      });

      const list = await sendToTab<{ ok: boolean; leads: ScrapedLead[] }>(tab.id, {
        type: "SCRAPE_PAGE",
      });
      if (!list?.ok) {
        await setRunState({ lastError: "Failed to scrape current page." });
        break;
      }

      const newLeads = list.leads.filter((l) => {
        if (!l.crunchbaseUrl) return false;
        if (seenUrls.has(l.crunchbaseUrl)) return false;
        seenUrls.add(l.crunchbaseUrl);
        return true;
      });

      const cur = await getRunState();
      await setRunState({ leadsScraped: cur.leadsScraped + newLeads.length });

      let batch: ScrapedLead[] = newLeads;
      if (cfg.profileDepth && newLeads.length > 0) {
        batch = await enrichWithProfileVisits(newLeads, cfg);
        if (stopRequested) {
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

      if (batchNum >= cfg.maxPages) break;

      // Re-focus the seed tab so click coordinates resolve on a foregrounded tab.
      try {
        await chrome.tabs.update(tab.id, { active: true });
        await sleep(400);
      } catch {
        /* ignore */
      }

      const advanced = await goNextPageWithVision(tab.id, cfg);
      if (!advanced) {
        // goNextPageWithVision has already set a specific lastError describing
        // why pagination failed. Don't overwrite it with a generic message.
        const cur = await getRunState();
        if (!cur.lastError) {
          await setRunState({
            lastError: `Pagination stopped after ${seenUrls.size} leads.`,
          });
        }
        break;
      }

      const ready = await waitForReady(tab.id, "list", 15000);
      if (!ready.ok) {
        await setRunState({
          lastError: `Page ${batchNum + 1} not ready (${ready.reason}).`,
        });
        break;
      }
      await sleep(jitter(cfg.pageDelayMs, 2000));
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

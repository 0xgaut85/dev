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

/**
 * Retry wrapper for chrome.tabs.* operations that occasionally throw
 * "Tabs cannot be edited right now (user may be dragging a tab)" — a
 * transient race condition in Chrome's tab subsystem. We wait a short
 * spell and try again before giving up.
 */
async function retryTabOp<T>(label: string, fn: () => Promise<T>, maxAttempts = 5): Promise<T> {
  let lastErr: unknown = null;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      // Only retry on the specific transient errors. Other failures bubble up.
      const transient = /cannot be edited|user may be dragging|No tab with id/i.test(msg);
      if (!transient || i === maxAttempts - 1) break;
      await sleep(500 + i * 500);
    }
  }
  throw lastErr instanceof Error
    ? new Error(`${label}: ${lastErr.message}`)
    : new Error(`${label}: failed after ${maxAttempts} attempts`);
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
  await retryTabOp("nav", () => chrome.tabs.update(tabId, { url }));
  await sleep(1500);
  return waitForReady(tabId, mode, timeoutMs);
}

// ---------- profile enrichment ----------

type VisitResult =
  | { ok: true; lead: ScrapedLead | null }
  | { ok: false; reason: "cloudflare" | "rate-limit" | "timeout" | "other" };

async function visitProfile(url: string, profileDelayMs: number): Promise<VisitResult> {
  let tab: chrome.tabs.Tab;
  try {
    tab = await retryTabOp("create tab", () => chrome.tabs.create({ url, active: false }));
  } catch {
    return { ok: false, reason: "other" };
  }
  if (!tab.id) return { ok: false, reason: "other" };
  const tabId = tab.id;
  try {
    const ready = await waitForReady(tabId, "profile", 15000);
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
    const r = await sendToTab<{ ok: boolean; lead: ScrapedLead | null }>(tabId, {
      type: "SCRAPE_PROFILE",
    });
    return { ok: true, lead: r?.lead ?? null };
  } finally {
    try {
      await retryTabOp("remove tab", () => chrome.tabs.remove(tabId));
    } catch {
      /* tab already gone or unrecoverable */
    }
    await sleep(jitter(profileDelayMs, 1500));
  }
}

/**
 * Iterate through list-page leads and open each profile. On Cloudflare /
 * rate-limit, back off (longer cooldowns each time) and retry, but keep
 * going on the same lead. Only abort the run if we hit `MAX_CF_HITS`
 * consecutive cloudflare blocks.
 *
 * Calls `onLead` for each processed lead (success or fallback), so the
 * caller can stream results to the API instead of waiting for the whole
 * batch to finish.
 */
async function enrichWithProfileVisits(
  listLeads: ScrapedLead[],
  cfg: Settings,
  onLead: (lead: ScrapedLead) => Promise<void> | void,
): Promise<void> {
  const MAX_CF_HITS = 5;
  let consecutiveCfHits = 0;

  for (const lead of listLeads) {
    if (stopRequested) break;

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

    const merged = result?.ok ? mergeListAndProfile(lead, result.lead) : lead;
    try {
      await onLead(merged);
    } catch (err) {
      await setRunState({
        lastError: `onLead callback failed: ${err instanceof Error ? err.message : "?"}`,
      });
    }
  }
}

// ---------- pagination strategies ----------

/**
 * Strategy A: navigate to the next page via URL manipulation. We read the
 * tab's current URL, ask the content script to compute the next-page URL by
 * either finding an in-DOM link or incrementing the pageId number, then
 * navigate there. This bypasses all click/screenshot machinery — it's the
 * most reliable approach for Crunchbase Discover.
 */
async function goNextPageViaUrl(
  tabId: number,
): Promise<"advanced" | "no-pageid" | "nav-failed" | "not-ready"> {
  const find = await sendToTab<{
    ok: boolean;
    url?: string;
    current?: { url: string; page: number; pageIdRaw: string | null };
    reason?: string;
    source?: string;
  }>(tabId, { type: "FIND_NEXT_URL" });

  if (!find?.ok || !find.url) {
    await setRunState({
      lastError: `URL pager: ${find?.reason ?? "no URL returned"} (current page=${find?.current?.page ?? "?"}, pageId=${find?.current?.pageIdRaw ?? "none"})`,
    });
    return find?.reason?.includes("no pageId") ? "no-pageid" : "nav-failed";
  }

  const targetUrl = find.url;
  await setRunState({
    lastError: `Navigating to next page (source=${find.source}, page=${(find.current?.page ?? 0) + 1})`,
  });

  // Snapshot the first row's href before navigation so we can confirm the
  // page actually turned (sometimes navigation no-ops if the cursor expired).
  const before = await sendToTab<{ ok: boolean; firstHref: string | null; url: string }>(
    tabId,
    { type: "GET_VIEWPORT" },
  );

  try {
    await retryTabOp("nav", () => chrome.tabs.update(tabId, { url: targetUrl }));
  } catch (err) {
    await setRunState({
      lastError: `Tab navigate failed: ${err instanceof Error ? err.message : "?"}`,
    });
    return "nav-failed";
  }

  // Wait for the new page to load.
  await sleep(1500);
  const ready = await waitForReady(tabId, "list", 15000);
  if (!ready.ok) {
    await setRunState({
      lastError: `Next page didn't load (${ready.reason}).`,
    });
    return "not-ready";
  }

  // Confirm the row contents actually changed (cursor hadn't expired).
  const after = await sendToTab<{ ok: boolean; firstHref: string | null; url: string }>(
    tabId,
    { type: "GET_VIEWPORT" },
  );
  if (
    after?.firstHref &&
    before?.firstHref &&
    after.firstHref === before.firstHref &&
    after.url === before.url
  ) {
    await setRunState({
      lastError: `Navigation succeeded but content didn't change — cursor may have expired.`,
    });
    return "nav-failed";
  }

  return "advanced";
}

/**
 * Try to advance to the next page using DOM heuristics first (fast & reliable
 * when Crunchbase's pager structure is stable). Returns:
 *   "advanced" — clicked + page actually turned
 *   "disabled" — found a Next button but it's disabled (last page)
 *   "not-found" — no plausible button found via DOM (caller should try vision)
 *   "click-failed" — clicked but page didn't turn (caller may try vision)
 */
async function goNextPageWithDom(
  tabId: number,
): Promise<"advanced" | "disabled" | "not-found" | "click-failed"> {
  // Snapshot anchors before click.
  const vp = await sendToTab<{
    ok: boolean;
    firstHref: string | null;
    url: string;
    counter: string | null;
  }>(tabId, { type: "GET_VIEWPORT" });
  if (!vp?.ok) return "not-found";

  const click = await sendToTab<{
    ok: boolean;
    found: boolean;
    disabled: boolean;
    reason?: string;
    targetTag?: string;
    ariaLabel?: string | null;
  }>(tabId, { type: "CLICK_NEXT_DOM" });

  if (!click) return "not-found";
  if (click.found && click.disabled) return "disabled";
  if (!click.ok) return "not-found";

  // Wait for page to actually turn.
  const turn = await sendToTab<{
    ok: boolean;
    advanced: boolean;
    via?: string;
    counter?: string | null;
  }>(tabId, {
    type: "WAIT_FOR_PAGE_TURN",
    firstHrefBefore: vp.firstHref,
    urlBefore: vp.url,
    counterBefore: vp.counter,
    timeoutMs: 15000,
  });
  if (turn?.advanced) {
    await setRunState({
      lastError: `DOM next click ok via ${turn.via} (target=${click.targetTag} aria="${click.ariaLabel ?? ""}")`,
    });
    return "advanced";
  }
  return "click-failed";
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
    tab = await retryTabOp("create seed tab", () =>
      chrome.tabs.create({ url: cfg.seedUrl, active: true }),
    );
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

      if (cfg.profileDepth && newLeads.length > 0) {
        // Stream-ingest: each profile is POSTed as it's scraped, so a mid-loop
        // crash only loses the in-flight lead, not the whole batch.
        const buffer: ScrapedLead[] = [];
        const flush = async () => {
          if (!buffer.length) return;
          const slice = buffer.splice(0, buffer.length);
          const sent = await postLeadsBatched(slice, cfg.batchSize);
          const s = await getRunState();
          await setRunState({ leadsSent: s.leadsSent + sent });
        };
        await enrichWithProfileVisits(newLeads, cfg, async (lead) => {
          buffer.push(lead);
          if (buffer.length >= cfg.batchSize) await flush();
        });
        await flush();
        if (stopRequested) break;
      } else if (newLeads.length) {
        // No profile-depth: ingest the list-only leads directly.
        const sent = await postLeadsBatched(newLeads, cfg.batchSize);
        const s = await getRunState();
        await setRunState({ leadsSent: s.leadsSent + sent });
      }

      if (batchNum >= cfg.maxPages) break;

      // Re-focus the seed tab. Best-effort with retry — non-fatal if it fails.
      try {
        const tabIdForFocus = tab.id;
        await retryTabOp("refocus", () => chrome.tabs.update(tabIdForFocus, { active: true }));
        await sleep(400);
      } catch {
        /* ignore */
      }

      // 1) URL-based: read current URL, increment pageId, navigate. This
      // bypasses screenshots / clicks entirely and is the most reliable.
      const urlResult = await goNextPageViaUrl(tab.id);
      let advanced = urlResult === "advanced";

      // 2) Fall back to clicking the Next button via DOM heuristics if the
      // URL strategy can't find a pageId (e.g. some Discover variants).
      if (!advanced) {
        await setRunState({
          lastError: `URL strategy failed (${urlResult}); trying DOM click…`,
        });
        const domResult = await goNextPageWithDom(tab.id);
        if (domResult === "disabled") {
          await setRunState({
            lastError: `Reached last page (${seenUrls.size} leads scraped). Next button is disabled.`,
          });
          break;
        }
        advanced = domResult === "advanced";
        if (!advanced) {
          await setRunState({
            lastError: `Both URL & DOM pagination failed (URL: ${urlResult}, DOM: ${domResult}). Stopping after ${seenUrls.size} leads.`,
          });
        }
      }

      if (!advanced) {
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

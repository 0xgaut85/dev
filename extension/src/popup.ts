import type { ScrapedLead, Settings } from "./types";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const apiUrlEl = $<HTMLInputElement>("apiUrl");
const apiTokenEl = $<HTMLInputElement>("apiToken");
const pageDelayEl = $<HTMLInputElement>("pageDelayMs");
const maxPagesEl = $<HTMLInputElement>("maxPages");
const saveBtn = $<HTMLButtonElement>("save");
const scrapeOneBtn = $<HTMLButtonElement>("scrapeOne");
const scrapeProfileBtn = $<HTMLButtonElement>("scrapeProfile");
const autoBtn = $<HTMLButtonElement>("autoScrape");
const stopBtn = $<HTMLButtonElement>("stop");
const statusEl = $<HTMLDivElement>("status");

let stopFlag = false;

function log(msg: string) {
  const t = new Date().toLocaleTimeString();
  statusEl.textContent = `[${t}] ${msg}\n` + statusEl.textContent;
}

async function loadSettings() {
  const s = (await chrome.runtime.sendMessage({ type: "GET_SETTINGS" })) as Settings;
  apiUrlEl.value = s.apiUrl;
  apiTokenEl.value = s.apiToken;
  pageDelayEl.value = String(s.pageDelayMs);
  maxPagesEl.value = String(s.maxPages);
}

async function saveSettings() {
  const next: Partial<Settings> = {
    apiUrl: apiUrlEl.value.trim(),
    apiToken: apiTokenEl.value.trim(),
    pageDelayMs: Math.max(2000, parseInt(pageDelayEl.value || "4500", 10)),
    maxPages: Math.min(50, Math.max(1, parseInt(maxPagesEl.value || "20", 10))),
  };
  await chrome.runtime.sendMessage({ type: "SET_SETTINGS", settings: next });
  log("Settings saved.");
}

async function getActiveTab(): Promise<chrome.tabs.Tab | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab ?? null;
}

async function sendToContent<T>(tabId: number, msg: unknown): Promise<T | null> {
  try {
    return (await chrome.tabs.sendMessage(tabId, msg)) as T;
  } catch (err) {
    log(`Content script not reachable: ${err instanceof Error ? err.message : "?"}`);
    return null;
  }
}

async function ingest(leads: ScrapedLead[]) {
  if (leads.length === 0) {
    log("No leads found on this page.");
    return;
  }
  const result = (await chrome.runtime.sendMessage({
    type: "INGEST",
    leads,
  })) as { ok: boolean; status?: number; body?: { inserted: number; updated: number }; error?: string };
  if (result.ok) {
    log(
      `Sent ${leads.length} leads → inserted ${result.body?.inserted ?? "?"}, updated ${
        result.body?.updated ?? "?"
      }`
    );
  } else {
    log(`Ingest failed: ${result.error ?? `HTTP ${result.status}`}`);
  }
}

scrapeOneBtn.addEventListener("click", async () => {
  const tab = await getActiveTab();
  if (!tab?.id) return;
  if (!tab.url?.includes("crunchbase.com")) {
    log("Open a crunchbase.com page first.");
    return;
  }
  const r = await sendToContent<{ ok: boolean; leads: ScrapedLead[] }>(tab.id, {
    type: "SCRAPE_PAGE",
  });
  if (!r?.ok) return;
  log(`Scraped ${r.leads.length} leads from current page.`);
  await ingest(r.leads);
});

scrapeProfileBtn.addEventListener("click", async () => {
  const tab = await getActiveTab();
  if (!tab?.id) return;
  const r = await sendToContent<{ ok: boolean; lead: ScrapedLead | null }>(tab.id, {
    type: "SCRAPE_PROFILE",
  });
  if (!r?.ok || !r.lead) {
    log("Not a profile page or no data extractable.");
    return;
  }
  log(`Scraped profile: ${r.lead.name}`);
  await ingest([r.lead]);
});

autoBtn.addEventListener("click", async () => {
  const tab = await getActiveTab();
  if (!tab?.id) return;
  if (!tab.url?.includes("crunchbase.com")) {
    log("Open a crunchbase.com search results page first.");
    return;
  }
  const settings = (await chrome.runtime.sendMessage({ type: "GET_SETTINGS" })) as Settings;
  const max = settings.maxPages;
  stopFlag = false;
  stopBtn.disabled = false;
  autoBtn.disabled = true;

  for (let i = 0; i < max; i++) {
    if (stopFlag) {
      log("Stopped by user.");
      break;
    }
    log(`Page ${i + 1}/${max}…`);
    const r = await sendToContent<{ ok: boolean; leads: ScrapedLead[] }>(tab.id, {
      type: "SCRAPE_PAGE",
    });
    if (!r?.ok) break;
    await ingest(r.leads);

    if (i < max - 1) {
      const next = await sendToContent<{ ok: boolean; clicked: boolean }>(tab.id, {
        type: "GO_NEXT_PAGE",
      });
      if (!next?.clicked) {
        log("No next page available, stopping.");
        break;
      }
      const jitter = settings.pageDelayMs + Math.floor(Math.random() * 2000);
      await new Promise((res) => setTimeout(res, jitter));
    }
  }

  stopBtn.disabled = true;
  autoBtn.disabled = false;
  log("Done.");
});

stopBtn.addEventListener("click", () => {
  stopFlag = true;
  log("Stop requested…");
});

saveBtn.addEventListener("click", saveSettings);

loadSettings();

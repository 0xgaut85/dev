import type { ScrapedLead, Settings, RunState } from "./types";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const apiUrlEl = $<HTMLInputElement>("apiUrl");
const apiTokenEl = $<HTMLInputElement>("apiToken");
const seedUrlEl = $<HTMLTextAreaElement>("seedUrl");
const profileDepthEl = $<HTMLInputElement>("profileDepth");
const pageDelayEl = $<HTMLInputElement>("pageDelayMs");
const profileDelayEl = $<HTMLInputElement>("profileDelayMs");
const maxPagesEl = $<HTMLInputElement>("maxPages");
const batchSizeEl = $<HTMLInputElement>("batchSize");
const saveBtn = $<HTMLButtonElement>("save");
const startBtn = $<HTMLButtonElement>("start");
const stopBtn = $<HTMLButtonElement>("stop");
const scrapeOneBtn = $<HTMLButtonElement>("scrapeOne");
const scrapeProfileBtn = $<HTMLButtonElement>("scrapeProfile");
const statusEl = $<HTMLDivElement>("status");
const progressEl = $<HTMLDivElement>("progress");

function log(msg: string) {
  const t = new Date().toLocaleTimeString();
  statusEl.textContent = `[${t}] ${msg}\n` + statusEl.textContent;
}

function renderProgress(state: RunState) {
  if (!state.running && state.startedAt == null) {
    progressEl.classList.remove("active");
    progressEl.textContent = "";
    startBtn.disabled = false;
    stopBtn.disabled = true;
    return;
  }
  progressEl.classList.add("active");
  const lines = [
    `${state.running ? "Running" : "Finished"} — page ${state.page}/${state.maxPages}`,
    `Leads scraped: ${state.leadsScraped} · sent: ${state.leadsSent}`,
    `Profiles visited: ${state.profilesVisited}`,
  ];
  if (state.lastError) lines.push(`Last issue: ${state.lastError}`);
  progressEl.textContent = lines.join("\n");
  startBtn.disabled = state.running;
  stopBtn.disabled = !state.running;
}

async function loadSettings() {
  const s = (await chrome.runtime.sendMessage({ type: "GET_SETTINGS" })) as Settings;
  apiUrlEl.value = s.apiUrl;
  apiTokenEl.value = s.apiToken;
  seedUrlEl.value = s.seedUrl;
  profileDepthEl.checked = s.profileDepth;
  pageDelayEl.value = String(s.pageDelayMs);
  profileDelayEl.value = String(s.profileDelayMs);
  maxPagesEl.value = String(s.maxPages);
  batchSizeEl.value = String(s.batchSize);
}

async function loadRunState() {
  const state = (await chrome.runtime.sendMessage({ type: "GET_RUN_STATE" })) as RunState;
  renderProgress(state);
}

async function saveSettings() {
  const next: Partial<Settings> = {
    apiUrl: apiUrlEl.value.trim(),
    apiToken: apiTokenEl.value.trim(),
    seedUrl: seedUrlEl.value.trim(),
    profileDepth: profileDepthEl.checked,
    pageDelayMs: Math.max(2000, parseInt(pageDelayEl.value || "4500", 10)),
    profileDelayMs: Math.max(1500, parseInt(profileDelayEl.value || "3500", 10)),
    maxPages: Math.min(200, Math.max(1, parseInt(maxPagesEl.value || "20", 10))),
    batchSize: Math.min(100, Math.max(1, parseInt(batchSizeEl.value || "25", 10))),
  };
  await chrome.runtime.sendMessage({ type: "SET_SETTINGS", settings: next });
  log("Settings saved.");
}

async function startAutoSearch() {
  await saveSettings();
  const r = (await chrome.runtime.sendMessage({ type: "START_AUTO_SEARCH" })) as {
    ok: boolean;
    error?: string;
  };
  if (!r.ok) {
    log(`Could not start: ${r.error}`);
    return;
  }
  log("Auto-search started. You can close this popup; it runs in the background.");
}

async function stopAutoSearch() {
  await chrome.runtime.sendMessage({ type: "STOP_AUTO_SEARCH" });
  log("Stop requested.");
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
  })) as {
    ok: boolean;
    status?: number;
    body?: { inserted: number; updated: number };
    error?: string;
  };
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

saveBtn.addEventListener("click", saveSettings);
startBtn.addEventListener("click", startAutoSearch);
stopBtn.addEventListener("click", stopAutoSearch);

chrome.runtime.onMessage.addListener((msg: { type: string; state?: RunState }) => {
  if (msg.type === "RUN_PROGRESS" && msg.state) {
    renderProgress(msg.state);
  }
});

loadSettings();
loadRunState();

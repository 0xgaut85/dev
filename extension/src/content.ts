import {
  scrapeSearchResults,
  scrapePersonProfile,
  scrollForMore,
  getScrollDebug,
  clickNextPage,
  hasNextPageButton,
} from "./scrape";
import { SELECTORS, isPersonProfilePage } from "./selectors";
import type { ScrapedLead } from "./types";

type Msg =
  | { type: "PING" }
  | { type: "SCRAPE_PAGE" }
  | { type: "SCRAPE_PROFILE" }
  | { type: "SCROLL_FOR_MORE" }
  | { type: "SCROLL_DEBUG" }
  | { type: "GO_NEXT_PAGE" }
  | { type: "HAS_NEXT_PAGE" }
  | { type: "WAIT_FOR_READY"; mode: "list" | "profile"; timeoutMs?: number };

function sleep(ms: number) {
  return new Promise((res) => setTimeout(res, ms));
}

function detectChallenge(): string | null {
  const html = document.documentElement.innerHTML;
  if (/cf-challenge|attention required|cloudflare/i.test(document.title)) return "cloudflare";
  if (/Just a moment|Verifying you are human/i.test(html)) return "cloudflare";
  if (/Rate limit|429/i.test(document.title)) return "rate-limit";
  return null;
}

async function waitForReady(
  mode: "list" | "profile",
  timeoutMs = 15000
): Promise<{ ok: boolean; reason?: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const challenge = detectChallenge();
    if (challenge) return { ok: false, reason: challenge };
    if (mode === "list") {
      const hasRows = document.querySelector(SELECTORS.personLinkInRow);
      if (hasRows) return { ok: true };
    } else {
      if (isPersonProfilePage() && document.querySelector(SELECTORS.profileName)) {
        return { ok: true };
      }
    }
    await sleep(400);
  }
  return { ok: false, reason: "timeout" };
}

chrome.runtime.onMessage.addListener((msg: Msg, _sender, sendResponse) => {
  if (msg.type === "PING") {
    sendResponse({ ok: true, url: location.href });
    return true;
  }
  if (msg.type === "SCRAPE_PAGE") {
    const leads: ScrapedLead[] = scrapeSearchResults();
    sendResponse({ ok: true, leads });
    return true;
  }
  if (msg.type === "SCRAPE_PROFILE") {
    scrapePersonProfile().then((lead) => sendResponse({ ok: true, lead }));
    return true;
  }
  if (msg.type === "SCROLL_FOR_MORE") {
    (async () => {
      const before = document.querySelectorAll(SELECTORS.personLinkInRow).length;
      const grew = await scrollForMore(12000);
      const after = document.querySelectorAll(SELECTORS.personLinkInRow).length;
      sendResponse({ ok: true, grew, before, after });
    })();
    return true;
  }
  if (msg.type === "SCROLL_DEBUG") {
    sendResponse({ ok: true, debug: getScrollDebug() });
    return true;
  }
  if (msg.type === "GO_NEXT_PAGE") {
    (async () => {
      const before = document.querySelectorAll(SELECTORS.personLinkInRow).length;
      const advanced = await clickNextPage(15000);
      const after = document.querySelectorAll(SELECTORS.personLinkInRow).length;
      sendResponse({ ok: true, advanced, before, after, url: location.href });
    })();
    return true;
  }
  if (msg.type === "HAS_NEXT_PAGE") {
    sendResponse({ ok: true, has: hasNextPageButton() });
    return true;
  }
  if (msg.type === "WAIT_FOR_READY") {
    waitForReady(msg.mode, msg.timeoutMs).then(sendResponse);
    return true;
  }
  return false;
});

import { scrapeSearchResults, scrapePersonProfile } from "./scrape";
import { SELECTORS, isPersonProfilePage } from "./selectors";
import type { ScrapedLead } from "./types";

type Msg =
  | { type: "PING" }
  | { type: "EXHAUST_GRID"; maxMs?: number }
  | { type: "SCRAPE_PAGE" }
  | { type: "SCRAPE_PROFILE" }
  | { type: "GET_VIEWPORT" }
  | { type: "CLICK_AT"; cssX: number; cssY: number }
  | {
      type: "WAIT_FOR_PAGE_TURN";
      firstHrefBefore: string | null;
      urlBefore: string | null;
      counterBefore: string | null;
      timeoutMs?: number;
    }
  | { type: "WAIT_FOR_READY"; mode: "list" | "profile"; timeoutMs?: number };

function sleep(ms: number) {
  return new Promise((res) => setTimeout(res, ms));
}

/**
 * Find the scrollable grid container ("the inner div that holds 50 person
 * rows and grows in scrollHeight"). Crunchbase Discover virtualizes rows, so
 * we have to scroll it ourselves to materialize all rows on the current page.
 */
function findGridContainer(): HTMLElement | null {
  const direct = document.querySelector<HTMLElement>(
    ".grid-id-people, [class*='grid-id-']",
  );
  if (direct) return direct;
  // Fallback: any element whose scrollHeight > clientHeight and contains person links.
  const all = Array.from(document.querySelectorAll<HTMLElement>("*"));
  for (const el of all) {
    if (el.scrollHeight - el.clientHeight < 200) continue;
    if (el.querySelector('a[href*="/person/"]')) return el;
  }
  return null;
}

function countPersonLinks(): number {
  return document.querySelectorAll('a[href*="/person/"]').length;
}

async function exhaustGrid(
  maxMs: number,
): Promise<{ rowsBefore: number; rowsAfter: number; scrolls: number; container: string | null }> {
  const grid = findGridContainer();
  const before = countPersonLinks();
  if (!grid) return { rowsBefore: before, rowsAfter: before, scrolls: 0, container: null };

  const deadline = Date.now() + maxMs;
  let lastCount = before;
  let stable = 0;
  let scrolls = 0;
  while (Date.now() < deadline) {
    grid.scrollTop = grid.scrollHeight;
    grid.dispatchEvent(new Event("scroll", { bubbles: true }));
    scrolls++;
    await sleep(450);
    const now = countPersonLinks();
    if (now === lastCount) {
      stable++;
      if (stable >= 3) break; // No new rows after 3 idle ticks ≈ 1.4s.
    } else {
      stable = 0;
      lastCount = now;
    }
  }
  // Scroll back to top so the pager toolbar is visible for the Grok screenshot.
  grid.scrollTop = 0;
  grid.dispatchEvent(new Event("scroll", { bubbles: true }));
  await sleep(300);
  return {
    rowsBefore: before,
    rowsAfter: countPersonLinks(),
    scrolls,
    container: grid.className || grid.tagName,
  };
}

/**
 * Reads the "1-50 of 1,163 results" counter near the top of Discover. Useful
 * as a "did the page advance?" signal that's more reliable than the first-row
 * href on lists where React replaces row contents in place.
 */
function readPagerCounter(): string | null {
  const re = /\d[\d,]*\s*[-–]\s*\d[\d,]*\s+of\s+\d[\d,]*/i;
  const candidates = document.querySelectorAll<HTMLElement>(
    "results-info, .results-info, [class*='results'], header, .page-controls, span, div",
  );
  for (let i = 0; i < candidates.length && i < 800; i++) {
    const t = candidates[i].textContent?.trim() ?? "";
    if (t.length > 200) continue;
    const m = t.match(re);
    if (m) return m[0].replace(/\s+/g, " ");
  }
  return null;
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
  if (msg.type === "EXHAUST_GRID") {
    (async () => {
      const out = await exhaustGrid(msg.maxMs ?? 12000);
      sendResponse({ ok: true, ...out });
    })();
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
  if (msg.type === "GET_VIEWPORT") {
    const firstHref =
      document.querySelector<HTMLAnchorElement>(SELECTORS.personLinkInRow)?.href ?? null;
    sendResponse({
      ok: true,
      width: window.innerWidth,
      height: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio || 1,
      url: location.href,
      firstHref,
      counter: readPagerCounter(),
    });
    return true;
  }
  if (msg.type === "CLICK_AT") {
    (async () => {
      const { cssX, cssY } = msg;
      const el = document.elementFromPoint(cssX, cssY) as HTMLElement | null;
      if (!el) {
        sendResponse({ ok: false, error: "no element at coords" });
        return;
      }
      // Walk up to the nearest button/a — the icon inside is often what's
      // returned by elementFromPoint, but the actual handler lives on the
      // parent button.
      const target = (el.closest("button, a, [role='button']") as HTMLElement) ?? el;
      target.scrollIntoView({ block: "center", behavior: "instant" as ScrollBehavior });
      await new Promise((r) => setTimeout(r, 80));
      const rect = target.getBoundingClientRect();
      const opts = {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
      } as const;
      target.dispatchEvent(new PointerEvent("pointerdown", opts));
      target.dispatchEvent(new MouseEvent("mousedown", opts));
      target.dispatchEvent(new PointerEvent("pointerup", opts));
      target.dispatchEvent(new MouseEvent("mouseup", opts));
      target.dispatchEvent(new MouseEvent("click", opts));
      (target as HTMLButtonElement).click?.();
      sendResponse({
        ok: true,
        targetTag: target.tagName,
        targetClass: target.className?.toString() ?? "",
      });
    })();
    return true;
  }
  if (msg.type === "WAIT_FOR_PAGE_TURN") {
    (async () => {
      const deadline = Date.now() + (msg.timeoutMs ?? 15000);
      let lastDiag: {
        firstHref: string | null;
        url: string;
        counter: string | null;
      } = {
        firstHref: msg.firstHrefBefore,
        url: location.href,
        counter: msg.counterBefore,
      };
      while (Date.now() < deadline) {
        const firstNow =
          document.querySelector<HTMLAnchorElement>(SELECTORS.personLinkInRow)?.href ?? null;
        const urlNow = location.href;
        const counterNow = readPagerCounter();

        const hrefChanged = !!firstNow && firstNow !== msg.firstHrefBefore;
        const urlChanged = urlNow !== msg.urlBefore;
        const counterChanged =
          !!counterNow && !!msg.counterBefore && counterNow !== msg.counterBefore;

        lastDiag = { firstHref: firstNow, url: urlNow, counter: counterNow };

        if (hrefChanged || urlChanged || counterChanged) {
          sendResponse({
            ok: true,
            advanced: true,
            via: hrefChanged ? "row" : urlChanged ? "url" : "counter",
            ...lastDiag,
          });
          return;
        }
        await sleep(400);
      }
      sendResponse({ ok: true, advanced: false, ...lastDiag });
    })();
    return true;
  }
  if (msg.type === "WAIT_FOR_READY") {
    waitForReady(msg.mode, msg.timeoutMs).then(sendResponse);
    return true;
  }
  return false;
});

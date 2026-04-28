import { scrapeSearchResults, scrapePersonProfile } from "./scrape";
import { SELECTORS, isPersonProfilePage } from "./selectors";
import type { ScrapedLead } from "./types";

type Msg =
  | { type: "PING" }
  | { type: "EXHAUST_GRID"; maxMs?: number }
  | { type: "SCRAPE_PAGE" }
  | { type: "SCRAPE_PROFILE" }
  | { type: "GET_VIEWPORT" }
  | { type: "FIND_NEXT_DOM" }
  | { type: "CLICK_NEXT_DOM" }
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
 * Walks the DOM to find the "1-50 of 1,163 results" counter element itself
 * (not just the text). Returns the element so we can use it as an anchor for
 * locating the adjacent Next button.
 */
function findCounterElement(): HTMLElement | null {
  const re = /\d[\d,]*\s*[-–]\s*\d[\d,]*\s+of\s+\d[\d,]*/i;
  // Prefer leaf elements: only check ones with no element children, so we
  // don't pick up huge wrappers that happen to contain the text.
  const all = document.querySelectorAll<HTMLElement>("span, div, p, b, strong, em, small");
  for (let i = 0; i < all.length && i < 5000; i++) {
    const el = all[i];
    if (el.children.length > 2) continue;
    const t = el.textContent?.trim() ?? "";
    if (t.length > 80 || t.length < 10) continue;
    if (re.test(t)) return el;
  }
  return null;
}

function readPagerCounter(): string | null {
  const re = /\d[\d,]*\s*[-–]\s*\d[\d,]*\s+of\s+\d[\d,]*/i;
  const el = findCounterElement();
  const t = el?.textContent?.trim() ?? "";
  const m = t.match(re);
  return m ? m[0].replace(/\s+/g, " ") : null;
}

/**
 * Locate the "Next page" button via DOM heuristics. We anchor on the pager
 * counter ("1-50 of 1,163") and search within its nearest interactive parent
 * for a button whose aria-label / icon / text suggests Next. Returns null if
 * we can't find a plausible button or it's disabled.
 */
function findNextButtonDom(): {
  found: boolean;
  disabled?: boolean;
  reason?: string;
  rect?: { x: number; y: number; width: number; height: number };
  el?: HTMLElement;
} {
  const counter = findCounterElement();
  if (!counter) return { found: false, reason: "counter not found in DOM" };

  // Climb up to a parent likely to contain the pager controls.
  let scope: HTMLElement | null = counter;
  for (let i = 0; i < 8 && scope; i++) {
    if (scope.querySelectorAll("button").length >= 1) break;
    scope = scope.parentElement;
  }
  if (!scope) return { found: false, reason: "no scope parent with buttons" };

  // Climb a few more levels to grab the prev+next buttons together.
  let widerScope: HTMLElement | null = scope;
  for (let i = 0; i < 4 && widerScope; i++) {
    if (widerScope.querySelectorAll("button").length >= 2) break;
    widerScope = widerScope.parentElement;
  }
  const searchRoot = widerScope ?? scope;

  const buttons = Array.from(
    searchRoot.querySelectorAll<HTMLElement>(
      "button, a[role='button'], [role='button']",
    ),
  );

  // Score each button by how "next-like" it is.
  const scored = buttons.map((b) => {
    const aria = (b.getAttribute("aria-label") ?? "").toLowerCase();
    const title = (b.getAttribute("title") ?? "").toLowerCase();
    const text = (b.textContent ?? "").trim().toLowerCase();
    const html = b.innerHTML.toLowerCase();
    let score = 0;
    if (/\bnext\b/.test(aria)) score += 10;
    if (/\bnext\b/.test(title)) score += 8;
    if (/\bnext page\b/.test(aria) || /\bnext page\b/.test(title)) score += 5;
    if (text === ">" || text === "›" || text === "→") score += 6;
    if (/chevron[_-]?right|arrow[_-]?right/.test(html)) score += 5;
    // Prev/back buttons should score negative.
    if (/\b(prev|previous|back)\b/.test(aria + " " + title + " " + text)) score -= 20;
    if (/chevron[_-]?left|arrow[_-]?left/.test(html)) score -= 10;
    return { el: b, score, aria, title, text };
  });

  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best || best.score <= 0) {
    return { found: false, reason: "no plausible next button near counter" };
  }

  const disabled =
    best.el.hasAttribute("disabled") ||
    best.el.getAttribute("aria-disabled") === "true" ||
    best.el.classList.contains("mat-mdc-button-disabled") ||
    best.el.classList.contains("mat-button-disabled");

  if (disabled) {
    return { found: true, disabled: true, reason: "next button is disabled — last page" };
  }

  const rect = best.el.getBoundingClientRect();
  return {
    found: true,
    disabled: false,
    rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
    el: best.el,
  };
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
  if (msg.type === "FIND_NEXT_DOM") {
    const r = findNextButtonDom();
    sendResponse({
      ok: true,
      found: r.found,
      disabled: r.disabled ?? false,
      reason: r.reason ?? null,
      rect: r.rect ?? null,
    });
    return true;
  }
  if (msg.type === "CLICK_NEXT_DOM") {
    (async () => {
      const r = findNextButtonDom();
      if (!r.found || r.disabled || !r.el) {
        sendResponse({
          ok: false,
          found: r.found,
          disabled: r.disabled ?? false,
          reason: r.reason ?? "not found",
        });
        return;
      }
      const target = r.el;
      target.scrollIntoView({ block: "center", behavior: "instant" as ScrollBehavior });
      await sleep(120);
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
        ariaLabel: target.getAttribute("aria-label"),
      });
    })();
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

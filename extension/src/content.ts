import { scrapeSearchResults, scrapePersonProfile } from "./scrape";
import { SELECTORS, isPersonProfilePage } from "./selectors";
import type { ScrapedLead } from "./types";

type Msg =
  | { type: "PING" }
  | { type: "SCRAPE_PAGE" }
  | { type: "SCRAPE_PROFILE" }
  | { type: "GET_VIEWPORT" }
  | { type: "CLICK_AT"; cssX: number; cssY: number }
  | { type: "WAIT_FOR_PAGE_TURN"; firstHrefBefore: string | null; timeoutMs?: number }
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
      while (Date.now() < deadline) {
        const firstNow =
          document.querySelector<HTMLAnchorElement>(SELECTORS.personLinkInRow)?.href ?? null;
        if (firstNow && firstNow !== msg.firstHrefBefore) {
          sendResponse({ ok: true, advanced: true, firstHref: firstNow });
          return;
        }
        await sleep(400);
      }
      sendResponse({ ok: true, advanced: false });
    })();
    return true;
  }
  if (msg.type === "WAIT_FOR_READY") {
    waitForReady(msg.mode, msg.timeoutMs).then(sendResponse);
    return true;
  }
  return false;
});

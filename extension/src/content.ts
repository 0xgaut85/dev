import { scrapeSearchResults, scrapePersonProfile, findNextPageButton } from "./scrape";
import type { ScrapedLead } from "./types";

type Msg =
  | { type: "PING" }
  | { type: "SCRAPE_PAGE" }
  | { type: "SCRAPE_PROFILE" }
  | { type: "GO_NEXT_PAGE" };

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
    const lead = scrapePersonProfile();
    sendResponse({ ok: true, lead });
    return true;
  }
  if (msg.type === "GO_NEXT_PAGE") {
    const btn = findNextPageButton();
    if (btn && !btn.disabled) {
      btn.click();
      sendResponse({ ok: true, clicked: true });
    } else {
      sendResponse({ ok: true, clicked: false });
    }
    return true;
  }
  return false;
});

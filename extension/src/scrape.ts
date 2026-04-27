import { SELECTORS, isPeopleSearchPage, isPersonProfilePage } from "./selectors";
import type { ScrapedLead } from "./types";

const ABSOLUTE_BASE = "https://www.crunchbase.com";

function abs(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url, ABSOLUTE_BASE).toString();
  } catch {
    return null;
  }
}

function textOf(el: Element | null): string {
  return (el?.textContent ?? "").trim();
}

function extractCountry(location: string | null): string | null {
  if (!location) return null;
  // Crunchbase formats: "San Francisco, California, United States" — last segment is country
  const parts = location.split(",").map((p) => p.trim()).filter(Boolean);
  return parts[parts.length - 1] ?? null;
}

function classifySocial(href: string): { type: "x" | "linkedin" | "website" | null; url: string } {
  const url = href;
  // Reject Crunchbase's own footer social links — those exist on every page.
  if (/twitter\.com\/crunchbase\b/i.test(href)) return { type: null, url };
  if (/x\.com\/crunchbase\b/i.test(href)) return { type: null, url };
  if (/linkedin\.com\/company\/crunchbase\b/i.test(href)) return { type: null, url };
  if (/facebook\.com\/crunchbase\b/i.test(href)) return { type: null, url };
  if (/instagram\.com\/crunchbase\b/i.test(href)) return { type: null, url };

  if (/(?:^|\/\/)(www\.)?(twitter|x)\.com\//i.test(href)) return { type: "x", url };
  if (/(?:^|\/\/)(www\.)?linkedin\.com\//i.test(href)) return { type: "linkedin", url };
  return { type: "website", url };
}

/**
 * Scrape rows from a People search results grid.
 * Robust to markup changes: we find every link to /person/<slug>, then climb
 * to its row container and pull text from sibling cells.
 */
export function scrapeSearchResults(): ScrapedLead[] {
  const links = Array.from(
    document.querySelectorAll<HTMLAnchorElement>(SELECTORS.personLinkInRow)
  );

  const seen = new Set<string>();
  const leads: ScrapedLead[] = [];

  for (const link of links) {
    const href = abs(link.getAttribute("href"));
    if (!href || !href.includes("/person/")) continue;
    if (seen.has(href)) continue;

    const name = textOf(link);
    if (!name || name.length < 2) continue;

    seen.add(href);

    // Walk up to find the row container — we look for the closest ancestor that
    // contains multiple "cells" (grid-cell, td, or grid-row classes).
    let row: Element | null = link;
    for (let i = 0; i < 10 && row; i++) {
      const cells = row.querySelectorAll('grid-cell, [role="row"] > *, td');
      if (cells.length >= 2) break;
      row = row.parentElement;
    }
    const rowEl = row ?? link.parentElement;

    // Photo: nearest img inside the row
    const img = rowEl?.querySelector("img") as HTMLImageElement | null;
    const photoUrl = abs(img?.getAttribute("src"));

    // Pull cell texts as a flat array; we don't know exact column order across
    // search variants, so we capture them all and let the dashboard make sense.
    const cellTexts = rowEl
      ? Array.from(rowEl.querySelectorAll("grid-cell, td"))
          .map((c) => textOf(c))
          .filter(Boolean)
      : [];

    // Heuristics: CB Rank is purely numeric; location contains commas; company
    // is often a chip-style tag. The "headline" is usually the longest text.
    let cbRank: number | null = null;
    let location: string | null = null;
    let company: string | null = null;
    let headline: string | null = null;

    for (const t of cellTexts) {
      if (t === name) continue;
      if (cbRank == null && /^[\d,]+$/.test(t.replace(/\s/g, ""))) {
        const n = parseInt(t.replace(/[^\d]/g, ""), 10);
        if (!isNaN(n) && n > 0 && n < 10_000_000) cbRank = n;
        continue;
      }
      if (location == null && t.includes(",") && t.length < 80) {
        location = t;
        continue;
      }
      if (headline == null && t.length > 20 && t.length < 250) {
        headline = t;
        continue;
      }
      if (company == null && t.length < 60 && /[A-Za-z]/.test(t)) {
        company = t;
      }
    }

    leads.push({
      crunchbaseUrl: href,
      name,
      photoUrl,
      headline,
      company,
      cbRank,
      location,
      country: extractCountry(location),
      industries: [],
      hasX: false,
      hasLinkedIn: false,
    });
  }

  return leads;
}

function collectSocials(): {
  xUrl: string | null;
  linkedInUrl: string | null;
  websiteUrl: string | null;
} {
  let xUrl: string | null = null;
  let linkedInUrl: string | null = null;
  let websiteUrl: string | null = null;

  // Primary: aria-labelled / cb-link tagged links inside profile body.
  document
    .querySelectorAll<HTMLAnchorElement>(SELECTORS.profileSocials)
    .forEach((a) => {
      const href = a.getAttribute("href");
      if (!href) return;
      const { type, url } = classifySocial(href);
      if (type === "x" && !xUrl) xUrl = url;
      if (type === "linkedin" && !linkedInUrl) linkedInUrl = url;
      if (type === "website" && !websiteUrl) websiteUrl = url;
    });

  // Fallback: scan all anchors inside the main profile area, but skip the
  // page footer (which contains Crunchbase's own social links).
  if (!xUrl || !linkedInUrl) {
    const main =
      document.querySelector("main") ||
      document.querySelector("profile-page") ||
      document.body;
    const footer = document.querySelector("footer");
    main
      .querySelectorAll<HTMLAnchorElement>(
        'a[href*="twitter.com"], a[href*="x.com"], a[href*="linkedin.com"]'
      )
      .forEach((a) => {
        if (footer && footer.contains(a)) return;
        const href = a.getAttribute("href");
        if (!href) return;
        const { type, url } = classifySocial(href);
        if (type === "x" && !xUrl) xUrl = url;
        if (type === "linkedin" && !linkedInUrl) linkedInUrl = url;
      });
  }
  return { xUrl, linkedInUrl, websiteUrl };
}

async function waitForSocialsToRender(timeoutMs = 6000): Promise<void> {
  // The Twitter / Social Media section can render after first paint.
  // Scroll the page once to trigger lazy-loading, then poll briefly.
  window.scrollTo({ top: document.body.scrollHeight / 2, behavior: "instant" as ScrollBehavior });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = document.querySelector(SELECTORS.profileSocials);
    if (found) {
      // Settle: give a tick for any remaining async render.
      await new Promise((r) => setTimeout(r, 200));
      window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
      return;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
}

/**
 * Scrape a single person profile page — richer data including social links
 * and industry chips. Use this when the user is on /person/<slug>.
 */
export async function scrapePersonProfile(): Promise<ScrapedLead | null> {
  if (!isPersonProfilePage()) return null;

  const name = textOf(document.querySelector(SELECTORS.profileName));
  if (!name) return null;

  await waitForSocialsToRender();

  const headline = textOf(document.querySelector(SELECTORS.profileHeadline));
  const img = document.querySelector(SELECTORS.profileImage) as HTMLImageElement | null;
  const photoUrl = abs(img?.getAttribute("src"));

  const { xUrl, linkedInUrl, websiteUrl } = collectSocials();

  const industries = Array.from(
    document.querySelectorAll<HTMLAnchorElement>(SELECTORS.industryChip)
  )
    .map((c) => textOf(c))
    .filter((t) => t.length > 0 && t.length < 50);

  // Location: try meta or any element labeled "Location"
  const locationEl = Array.from(document.querySelectorAll("label-with-info, fields-card"))
    .find((el) => /location|headquarters/i.test(el.textContent ?? ""));
  const personLocation = locationEl
    ? textOf(locationEl).replace(/^.*?location/i, "").trim()
    : null;

  return {
    crunchbaseUrl: window.location.href,
    name,
    photoUrl,
    headline,
    company: null,
    cbRank: null,
    location: personLocation,
    country: extractCountry(personLocation),
    industries: Array.from(new Set(industries)).slice(0, 10),
    hasX: !!xUrl,
    hasLinkedIn: !!linkedInUrl,
    xUrl,
    linkedInUrl,
    websiteUrl,
  };
}

/**
 * Crunchbase Discover uses infinite scroll on an inner container, not pagination.
 * The container is `<div class="grid-id-people">` (or similar, in case classes
 * change). We find the nearest scrollable ancestor of the first person row.
 */
function findScrollContainer(): HTMLElement | null {
  const firstRow = document.querySelector<HTMLAnchorElement>(SELECTORS.personLinkInRow);
  if (!firstRow) return null;
  let el: HTMLElement | null = firstRow.parentElement as HTMLElement | null;
  for (let i = 0; i < 25 && el; i++) {
    const cs = window.getComputedStyle(el);
    const overflowY = cs.overflowY;
    const scrollable =
      (overflowY === "auto" || overflowY === "scroll") &&
      el.scrollHeight > el.clientHeight + 5;
    if (scrollable) return el;
    el = el.parentElement;
  }
  return null;
}

function rowCount(): number {
  return document.querySelectorAll(SELECTORS.personLinkInRow).length;
}

/**
 * Scroll the results container down to trigger lazy-load of more rows.
 * Returns true if new rows appeared, false if we hit the end.
 */
export async function scrollForMore(timeoutMs = 20000): Promise<boolean> {
  const container = findScrollContainer();
  if (!container) return false;

  const before = rowCount();

  const nudge = () => {
    container.scrollTop = container.scrollHeight;
    container.dispatchEvent(new Event("scroll", { bubbles: true }));
    container.dispatchEvent(
      new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        deltaY: 800,
      })
    );
  };

  // Short nudge sequence: alternate scrolling near-bottom and full-bottom to
  // trick virtualized intersection observers into firing.
  for (let i = 0; i < 5; i++) {
    nudge();
    await new Promise((r) => setTimeout(r, 250));
    container.scrollTop = container.scrollHeight - container.clientHeight - 10;
    await new Promise((r) => setTimeout(r, 150));
    nudge();
  }

  const deadline = Date.now() + timeoutMs;
  let lastSeen = before;
  while (Date.now() < deadline) {
    const now = rowCount();
    if (now > before) return true;
    // If something is loading slowly, give it more time. Otherwise keep
    // alternating positions to nudge the observer.
    if (now !== lastSeen) lastSeen = now;
    nudge();
    await new Promise((r) => setTimeout(r, 600));
  }
  return false;
}

/**
 * Crunchbase Discover shows a pager at the top of the results header:
 *   "1-50 of 1,163 results"  [<]  [>]
 * The next-arrow is a button with an icon. We locate it by finding the
 * element containing the "X-Y of Z results" text and grabbing the right-most
 * clickable arrow within that header row.
 */
function findResultsHeader(): HTMLElement | null {
  // Look for any element whose direct text matches the "of N results" pattern.
  const all = document.querySelectorAll<HTMLElement>(
    "span, div, results-info, page-buttons, paginator"
  );
  for (const el of all) {
    const txt = (el.textContent ?? "").trim();
    // Must mention "of <num> results" but not be huge (avoid <body>).
    if (/\d[\d,]*\s*-\s*\d[\d,]*\s+of\s+\d[\d,]*\s+results/i.test(txt) && txt.length < 200) {
      return el;
    }
  }
  return null;
}

function findNextPageButton(): HTMLElement | null {
  // Prefer aria-labelled buttons anywhere on the page first.
  const labelled = document.querySelector<HTMLElement>(SELECTORS.nextPageButton);
  if (labelled && isClickable(labelled)) return labelled;

  // Otherwise look near the results header for the right-most arrow button.
  const header = findResultsHeader();
  if (header) {
    // Walk up a few levels — buttons usually live in a sibling container.
    let scope: HTMLElement | null = header;
    for (let i = 0; i < 4 && scope; i++) {
      const buttons = Array.from(
        scope.querySelectorAll<HTMLElement>("button, a")
      ).filter(isClickable);
      if (buttons.length >= 2) {
        // The pager has [prev][next]. Pick the last enabled one whose
        // bounding-box sits to the right of the header text.
        const headerRect = header.getBoundingClientRect();
        const candidates = buttons.filter((b) => {
          const r = b.getBoundingClientRect();
          return r.left >= headerRect.left && r.width < 80 && r.height < 80;
        });
        const ordered = candidates.length >= 2 ? candidates : buttons;
        // The next button is the right-most one that isn't disabled.
        const sorted = [...ordered].sort(
          (a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left
        );
        const last = sorted[sorted.length - 1];
        if (last && isClickable(last) && !isDisabled(last)) return last;
      }
      scope = scope.parentElement;
    }
  }
  return null;
}

function isClickable(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return false;
  const cs = window.getComputedStyle(el);
  if (cs.visibility === "hidden" || cs.display === "none") return false;
  return true;
}

function isDisabled(el: HTMLElement): boolean {
  if (el.hasAttribute("disabled")) return true;
  if (el.getAttribute("aria-disabled") === "true") return true;
  if (el.classList.contains("disabled") || el.classList.contains("mat-mdc-button-disabled"))
    return true;
  return false;
}

/**
 * Click the "Next page" arrow next to the "1-50 of N results" header.
 * Returns true if the click fired AND new rows replaced the previous set.
 */
export async function clickNextPage(timeoutMs = 15000): Promise<boolean> {
  const btn = findNextPageButton();
  if (!btn) return false;

  // Capture an "anchor" — first row's href — so we can detect refresh.
  const firstHrefBefore =
    document.querySelector<HTMLAnchorElement>(SELECTORS.personLinkInRow)?.href ?? null;
  const urlBefore = location.href;

  btn.scrollIntoView({ block: "center", behavior: "instant" as ScrollBehavior });
  await new Promise((r) => setTimeout(r, 100));

  const rect = btn.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const opts = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy } as const;
  btn.dispatchEvent(new PointerEvent("pointerdown", opts));
  btn.dispatchEvent(new MouseEvent("mousedown", opts));
  btn.dispatchEvent(new PointerEvent("pointerup", opts));
  btn.dispatchEvent(new MouseEvent("mouseup", opts));
  btn.dispatchEvent(new MouseEvent("click", opts));
  (btn as HTMLButtonElement).click?.();

  // Wait for either the URL to change (pageId param updates) or the first row
  // to swap out — whichever happens first.
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300));
    if (location.href !== urlBefore) {
      // Then wait for the first new row to render (lazy).
      const rowDeadline = Date.now() + 8000;
      while (Date.now() < rowDeadline) {
        const firstNow =
          document.querySelector<HTMLAnchorElement>(SELECTORS.personLinkInRow)?.href ?? null;
        if (firstNow && firstNow !== firstHrefBefore) return true;
        await new Promise((r) => setTimeout(r, 300));
      }
      return true;
    }
    const firstNow =
      document.querySelector<HTMLAnchorElement>(SELECTORS.personLinkInRow)?.href ?? null;
    if (firstNow && firstNow !== firstHrefBefore) return true;
  }
  return false;
}

export function hasNextPageButton(): boolean {
  return findNextPageButton() !== null;
}

export function getScrollDebug(): {
  found: boolean;
  rowCount: number;
  scrollHeight?: number;
  clientHeight?: number;
  scrollTop?: number;
  className?: string;
} {
  const container = findScrollContainer();
  if (!container) return { found: false, rowCount: rowCount() };
  return {
    found: true,
    rowCount: rowCount(),
    scrollHeight: container.scrollHeight,
    clientHeight: container.clientHeight,
    scrollTop: container.scrollTop,
    className: container.className?.toString(),
  };
}

/**
 * Merge a list-row lead with profile data. Profile data wins on every field
 * that the profile page actually populated (non-null/non-empty), since the
 * profile is the authoritative source for socials, photo, headline, industries.
 */
export function mergeListAndProfile(list: ScrapedLead, profile: ScrapedLead): ScrapedLead {
  const pick = <T,>(p: T | null | undefined, l: T | null | undefined): T | null => {
    if (p !== null && p !== undefined && p !== "") return p as T;
    if (l !== null && l !== undefined && l !== "") return l as T;
    return null;
  };
  return {
    crunchbaseUrl: list.crunchbaseUrl || profile.crunchbaseUrl,
    name: profile.name || list.name,
    photoUrl: pick(profile.photoUrl, list.photoUrl),
    headline: pick(profile.headline, list.headline),
    company: pick(profile.company, list.company),
    cbRank: list.cbRank ?? profile.cbRank ?? null,
    location: pick(profile.location, list.location),
    country: pick(profile.country, list.country),
    industries:
      profile.industries && profile.industries.length > 0
        ? profile.industries
        : list.industries ?? [],
    hasX: profile.hasX ?? list.hasX ?? false,
    hasLinkedIn: profile.hasLinkedIn ?? list.hasLinkedIn ?? false,
    xUrl: pick(profile.xUrl, list.xUrl),
    linkedInUrl: pick(profile.linkedInUrl, list.linkedInUrl),
    websiteUrl: pick(profile.websiteUrl, list.websiteUrl),
  };
}

export { isPeopleSearchPage, isPersonProfilePage };

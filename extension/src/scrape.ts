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

/**
 * Scrape a single person profile page — richer data including social links
 * and industry chips. Use this when the user is on /person/<slug>.
 */
export function scrapePersonProfile(): ScrapedLead | null {
  if (!isPersonProfilePage()) return null;

  const name = textOf(document.querySelector(SELECTORS.profileName));
  if (!name) return null;

  const headline = textOf(document.querySelector(SELECTORS.profileHeadline));
  const img = document.querySelector(SELECTORS.profileImage) as HTMLImageElement | null;
  const photoUrl = abs(img?.getAttribute("src"));

  let xUrl: string | null = null;
  let linkedInUrl: string | null = null;
  let websiteUrl: string | null = null;

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
export async function scrollForMore(timeoutMs = 12000): Promise<boolean> {
  const container = findScrollContainer();
  if (!container) return false;

  const before = rowCount();
  // Multiple scroll nudges in case the virtualization needs a few ticks.
  for (let i = 0; i < 3; i++) {
    container.scrollTop = container.scrollHeight;
    container.dispatchEvent(new Event("scroll", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 300));
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (rowCount() > before) return true;
    // Keep nudging — Crunchbase loads in batches as the bottom sentinel enters view.
    container.scrollTop = container.scrollHeight;
    container.dispatchEvent(new Event("scroll", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
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

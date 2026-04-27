// Centralized DOM selectors for Crunchbase. Update here when the markup changes.
//
// Crunchbase uses both `discover/people` and `search/people` style routes;
// results render as a grid table of rows, each row being a link to a profile.
// We're intentionally loose: we look for any anchor pointing to /person/<slug>
// inside the main content area and walk back up to the row.

export const SELECTORS = {
  // Container for any row that links to a person profile.
  personLinkInRow: 'a[href^="/person/"]',
  // Pagination "next page" arrow on grid view.
  nextPageButton: 'button[aria-label="Next page"], button[mat-icon-button][aria-label*="next" i]',
  // Profile detail page elements
  profileName: 'h1, [class*="profile-name"]',
  profileHeadline: '[class*="description"], [class*="headline"]',
  profileSocials: 'a[href*="twitter.com"], a[href*="x.com"], a[href*="linkedin.com"]',
  profileImage: 'img[class*="profile"], profile-image img, identifier-multi-formatter img',
  // Industries/tags appear in chip lists on profile and on the row
  industryChip: 'chips-container a, [class*="chip"]',
};

export function isPeopleSearchPage(): boolean {
  const path = location.pathname;
  return (
    path.startsWith("/discover/people") ||
    path.startsWith("/search/people") ||
    path.includes("/people")
  );
}

export function isPersonProfilePage(): boolean {
  return location.pathname.startsWith("/person/");
}

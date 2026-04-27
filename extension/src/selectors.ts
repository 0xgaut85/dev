// Centralized DOM selectors for Crunchbase. Update here when the markup changes.
//
// Crunchbase uses both `discover/people` and `search/people` style routes;
// results render as a grid table of rows, each row being a link to a profile.
// We're intentionally loose: we look for any anchor pointing to /person/<slug>
// inside the main content area and walk back up to the row.

export const SELECTORS = {
  // Container for any row that links to a person profile.
  personLinkInRow: 'a[href^="/person/"]',
  // Profile detail page elements
  profileName: 'h1, [class*="profile-name"]',
  profileHeadline: '[class*="description"], [class*="headline"]',
  // Crunchbase renders profile social links as anchors with explicit
  // aria-labels: "View on Twitter", "View on LinkedIn", "View on Facebook",
  // etc. Targeting those keeps us out of the page footer (which holds
  // Crunchbase's *own* social links, not the profile owner's).
  profileSocials: [
    'a[aria-label="View on Twitter"]',
    'a[aria-label="View on LinkedIn"]',
    'a[aria-label="View on Facebook"]',
    'a[aria-label="View on Instagram"]',
    'a[title="View on Twitter"]',
    'a[title="View on LinkedIn"]',
    // The "Eiso Kant on Twitter" style link in the dedicated Twitter section
    'a[href*="twitter.com/"][cb-link]',
    'a[href*="x.com/"][cb-link]',
  ].join(", "),
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

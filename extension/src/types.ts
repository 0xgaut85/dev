export type ScrapedLead = {
  crunchbaseUrl: string;
  name: string;
  photoUrl?: string | null;
  headline?: string | null;
  company?: string | null;
  cbRank?: number | null;
  location?: string | null;
  country?: string | null;
  industries?: string[];
  hasX?: boolean;
  hasLinkedIn?: boolean;
  xUrl?: string | null;
  linkedInUrl?: string | null;
  websiteUrl?: string | null;
};

export type Settings = {
  apiUrl: string;
  apiToken: string;
  pageDelayMs: number;
  maxPages: number;
};

export const DEFAULT_SETTINGS: Settings = {
  apiUrl: "",
  apiToken: "",
  pageDelayMs: 4500,
  maxPages: 20,
};

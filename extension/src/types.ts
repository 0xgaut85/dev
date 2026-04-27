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
  seedUrl: string;
  profileDepth: boolean;
  profileDelayMs: number;
  profileConcurrency: number;
  batchSize: number;
};

export const DEFAULT_SETTINGS: Settings = {
  apiUrl: "",
  apiToken: "",
  pageDelayMs: 4500,
  maxPages: 20,
  seedUrl: "",
  profileDepth: true,
  profileDelayMs: 3500,
  profileConcurrency: 1,
  batchSize: 25,
};

export type RunState = {
  running: boolean;
  page: number;
  maxPages: number;
  leadsScraped: number;
  leadsSent: number;
  profilesVisited: number;
  lastError: string | null;
  startedAt: number | null;
};

export const DEFAULT_RUN_STATE: RunState = {
  running: false,
  page: 0,
  maxPages: 0,
  leadsScraped: 0,
  leadsSent: 0,
  profilesVisited: 0,
  lastError: null,
  startedAt: null,
};

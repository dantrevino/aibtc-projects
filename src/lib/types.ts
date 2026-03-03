/** Cloudflare Worker environment bindings */
export interface Env {
  ROADMAP_KV: KVNamespace;
  PROJECTS_DO: DurableObjectNamespace;
  WORKER_LOGS: Fetcher;
  GITHUB_TOKEN?: string;
  REFRESH_KEY?: string;
  ENVIRONMENT?: string;
}

/** Authenticated AIBTC agent */
export interface Agent {
  btcAddress: string;
  stxAddress?: string;
  displayName: string;
  description?: string;
  agentId?: string | null;
}

/** A project item in the roadmap */
export interface ProjectItem {
  id: string;
  title: string;
  description: string;
  githubUrl: string;
  githubData: GitHubData | null;
  founder: AgentRef;
  contributors: AgentRef[];
  leader: LeaderRef | null;
  status: ProjectStatus;
  claimedBy: ClaimRef | null;
  deliverables: Deliverable[];
  ratings: Rating[];
  reputation: Reputation;
  goals: Goal[];
  goalHistory?: Goal[];
  mentions: { count: number };
  searchTerms?: string[];
  website: WebsiteInfo | null;
  createdAt: string;
  updatedAt: string;
}

export type ProjectStatus = "todo" | "in-progress" | "done" | "blocked";

export interface GitHubData {
  type: "repo" | "issue" | "pr";
  number: number | null;
  title: string;
  state: string;
  merged: boolean;
  assignees: string[];
  labels: string[];
  stars?: number;
  homepage?: string | null;
  ownerLogin?: string | null;
  fetchedAt: string | null;
  _notFound?: boolean;
  _notFoundCount?: number;
}

export interface AgentRef {
  btcAddress: string;
  displayName: string;
  agentId?: string | null;
}

export interface LeaderRef extends AgentRef {
  profileUrl: string;
  assignedAt: string;
  lastActiveAt: string;
}

export interface ClaimRef extends AgentRef {
  claimedAt: string;
}

export interface Deliverable {
  id?: string;
  url: string;
  title: string;
  addedBy: AgentRef;
  addedAt: string;
}

export interface Rating {
  agentId?: string | null;
  btcAddress: string;
  displayName: string;
  score: number;
  review: string | null;
  ratedAt: string;
}

export interface Reputation {
  average: number;
  count: number;
}

export interface Goal {
  id: string;
  title: string;
  completed: boolean;
  addedBy: AgentRef;
  addedAt: string;
  completedAt: string | null;
}

export interface WebsiteInfo {
  url: string;
  source: string;
  discoveredAt: string;
}

/** KV data envelope */
export interface RoadmapData {
  version: number;
  writeVersion: number;
  items: ProjectItem[];
  updatedAt?: string;
}

/** Activity event stored in KV and DO */
export interface ActivityEvent {
  id: string;
  type: string;
  timestamp: string;
  agent: AgentRef | null;
  itemId: string | null;
  itemTitle: string | null;
  data: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Durable Object storage types
// ---------------------------------------------------------------------------

/** Alarm task types for the DO alarm chain */
export type AlarmTask =
  | "github-refresh"
  | "mention-scan"
  | "contributor-scan"
  | "pr-scan"
  | "website-discovery";

/** Alarm chain schedule — maps task to interval in minutes */
export const ALARM_SCHEDULE: Record<AlarmTask, number> = {
  "github-refresh": 15,
  "mention-scan": 10,
  "contributor-scan": 15,
  "pr-scan": 15,
  "website-discovery": 30,
} as const;

/** Ordered list of alarm tasks for round-robin chain */
export const ALARM_CHAIN: AlarmTask[] = [
  "github-refresh",
  "mention-scan",
  "contributor-scan",
  "pr-scan",
  "website-discovery",
];

/** Metadata for tracking alarm state */
export interface AlarmMeta {
  lastTask: AlarmTask | null;
  lastRunAt: string | null;
  taskHistory: Array<{ task: AlarmTask; ranAt: string; durationMs: number }>;
}

/** Mention scan state stored in DO */
export interface MentionScanState {
  lastScanAt: string | null;
  processedIds: string[];
}

/** GitHub scan state per repo */
export interface GitHubScanRepo {
  lastFetchAt: string | null;
  failureCount: number;
  lastPrScanAt: string | null;
  lastContributorScanAt: string | null;
}

/** GitHub scan state stored in DO */
export interface GitHubScanState {
  version: number;
  repos: Record<string, GitHubScanRepo>;
}

/** GitHub username → AIBTC agent address mapping */
export interface GitHubMapState {
  mapping: Record<string, string>;
}

/** Message archive stored in DO */
export interface MessageArchive {
  messages: ActivityEvent[];
}

/** Result envelope for DO RPC responses */
export interface DOResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

/** Storage key prefixes used by the DO */
export const STORAGE_KEYS = {
  /** Individual project: project:{id} */
  projectPrefix: "project:",
  /** Ordered list of project IDs */
  projectOrder: "meta:projectOrder",
  /** Schema version */
  schemaVersion: "meta:schemaVersion",
  /** Whether KV migration has run */
  migrated: "meta:migrated",
  /** Alarm chain metadata */
  alarmMeta: "meta:alarm",
  /** Activity events: event:{timestamp}:{id} */
  eventPrefix: "event:",
  /** Mention scan state */
  mentionScan: "scan:mentions",
  /** GitHub scan state */
  githubScan: "scan:github",
  /** GitHub username→address mapping */
  githubMap: "scan:github-map",
  /** Message archive */
  messageArchive: "scan:messages",
} as const;

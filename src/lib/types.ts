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

/** Activity event stored in KV */
export interface ActivityEvent {
  id: string;
  type: string;
  timestamp: string;
  agent: AgentRef | null;
  itemId: string | null;
  itemTitle: string | null;
  data: Record<string, unknown>;
}

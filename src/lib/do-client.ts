import type {
  Env,
  Agent,
  ProjectItem,
  ActivityEvent,
  DOResult,
  MentionScanState,
  GitHubScanState,
  GitHubMapState,
  MessageArchive,
  RoadmapData,
} from "./types";
import { KV_KEY } from "./constants";

/** Singleton DO stub ID — single instance manages all projects */
const DO_ID_NAME = "projects-singleton";

/** Get a stub for the projects DO */
function getStub(env: Env): DurableObjectStub {
  const id = env.PROJECTS_DO.idFromName(DO_ID_NAME);
  return env.PROJECTS_DO.get(id);
}

/** Type-safe fetch helper */
async function doFetch<T>(
  stub: DurableObjectStub,
  path: string,
  init?: RequestInit
): Promise<DOResult<T>> {
  const res = await stub.fetch(`https://do${path}`, init);
  return (await res.json()) as DOResult<T>;
}

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

/**
 * Ensure DO has been populated from KV. Call this on first request
 * (e.g., in items.get handler). Idempotent — skips if already migrated.
 */
export async function ensureMigrated(env: Env): Promise<void> {
  const stub = getStub(env);

  // Check health first — if already migrated, skip KV read
  const health = await doFetch<{ migrated: boolean }>(stub, "/health");
  if (health.data?.migrated) return;

  // Read KV data and send to DO for migration
  const kvData = await env.ROADMAP_KV.get<RoadmapData>(KV_KEY, "json");
  if (!kvData) return; // No KV data to migrate

  await doFetch(stub, "/migrate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kvData }),
  });
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export async function listProjects(env: Env): Promise<ProjectItem[]> {
  const stub = getStub(env);
  const result = await doFetch<ProjectItem[]>(stub, "/projects");
  return result.data ?? [];
}

export async function getProject(
  env: Env,
  id: string
): Promise<ProjectItem | null> {
  const stub = getStub(env);
  const result = await doFetch<ProjectItem>(stub, `/projects/${encodeURIComponent(id)}`);
  return result.ok ? (result.data ?? null) : null;
}

export async function createProject(
  env: Env,
  item: ProjectItem
): Promise<DOResult<ProjectItem>> {
  const stub = getStub(env);
  return doFetch<ProjectItem>(stub, "/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(item),
  });
}

export async function updateProject(
  env: Env,
  id: string,
  updates: Partial<ProjectItem>
): Promise<DOResult<ProjectItem>> {
  const stub = getStub(env);
  return doFetch<ProjectItem>(stub, `/projects/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(updates),
  });
}

export async function deleteProject(
  env: Env,
  id: string
): Promise<DOResult<ProjectItem>> {
  const stub = getStub(env);
  return doFetch<ProjectItem>(stub, `/projects/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export async function reorderProjects(
  env: Env,
  order: string[]
): Promise<DOResult<string[]>> {
  const stub = getStub(env);
  return doFetch<string[]>(stub, "/reorder", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ order }),
  });
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export async function listEvents(
  env: Env,
  opts?: { limit?: number; type?: string; itemId?: string; cursor?: string }
): Promise<{
  events: ActivityEvent[];
  total: number;
  cursor: string | null;
}> {
  const stub = getStub(env);
  const params = new URLSearchParams();
  if (opts?.limit) params.set("limit", String(opts.limit));
  if (opts?.type) params.set("type", opts.type);
  if (opts?.itemId) params.set("itemId", opts.itemId);
  if (opts?.cursor) params.set("cursor", opts.cursor);

  const qs = params.toString();
  const result = await doFetch<{
    events: ActivityEvent[];
    total: number;
    cursor: string | null;
  }>(stub, `/events${qs ? `?${qs}` : ""}`);

  return result.data ?? { events: [], total: 0, cursor: null };
}

export async function recordEvent(
  env: Env,
  event: Omit<ActivityEvent, "id" | "timestamp">
): Promise<ActivityEvent | null> {
  const stub = getStub(env);
  const result = await doFetch<ActivityEvent>(stub, "/events", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(event),
  });
  return result.data ?? null;
}

// ---------------------------------------------------------------------------
// Agent cache
// ---------------------------------------------------------------------------

/** Get cached agent from DO (returns null if not cached or expired) */
export async function getAgentCache(
  env: Env,
  address: string
): Promise<Agent | null> {
  const stub = getStub(env);
  const result = await doFetch<Agent | null>(
    stub,
    `/agent-cache/${encodeURIComponent(address)}`
  );
  return result.data ?? null;
}

/** Cache a verified agent in DO storage */
export async function putAgentCache(
  env: Env,
  address: string,
  agent: Agent
): Promise<void> {
  const stub = getStub(env);
  await doFetch(stub, `/agent-cache/${encodeURIComponent(address)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(agent),
  });
}

// ---------------------------------------------------------------------------
// Scan state
// ---------------------------------------------------------------------------

export async function getMentionScanState(
  env: Env
): Promise<MentionScanState> {
  const stub = getStub(env);
  const result = await doFetch<MentionScanState>(stub, "/scan/mentions");
  return result.data ?? { lastScanAt: null, processedIds: [] };
}

export async function putMentionScanState(
  env: Env,
  state: MentionScanState
): Promise<void> {
  const stub = getStub(env);
  await doFetch(stub, "/scan/mentions", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(state),
  });
}

export async function getGitHubScanState(
  env: Env
): Promise<GitHubScanState> {
  const stub = getStub(env);
  const result = await doFetch<GitHubScanState>(stub, "/scan/github");
  return result.data ?? { version: 1, repos: {} };
}

export async function putGitHubScanState(
  env: Env,
  state: GitHubScanState
): Promise<void> {
  const stub = getStub(env);
  await doFetch(stub, "/scan/github", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(state),
  });
}

export async function getGitHubMap(env: Env): Promise<GitHubMapState> {
  const stub = getStub(env);
  const result = await doFetch<GitHubMapState>(stub, "/scan/github-map");
  return result.data ?? { mapping: {} };
}

export async function putGitHubMap(
  env: Env,
  state: GitHubMapState
): Promise<void> {
  const stub = getStub(env);
  await doFetch(stub, "/scan/github-map", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(state),
  });
}

export async function getMessageArchive(
  env: Env
): Promise<MessageArchive> {
  const stub = getStub(env);
  const result = await doFetch<MessageArchive>(stub, "/scan/messages");
  return result.data ?? { messages: [] };
}

export async function putMessageArchive(
  env: Env,
  state: MessageArchive
): Promise<void> {
  const stub = getStub(env);
  await doFetch(stub, "/scan/messages", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(state),
  });
}

// ---------------------------------------------------------------------------
// Alarms
// ---------------------------------------------------------------------------

export async function startAlarms(env: Env): Promise<void> {
  const stub = getStub(env);
  await doFetch(stub, "/alarms/start", { method: "POST" });
}

export async function getAlarmStatus(
  env: Env
): Promise<Record<string, unknown>> {
  const stub = getStub(env);
  const result = await doFetch<Record<string, unknown>>(
    stub,
    "/alarms/status"
  );
  return result.data ?? {};
}

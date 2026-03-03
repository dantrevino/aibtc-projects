/**
 * Alarm task implementations — ported from v1's functions/api/_tasks.js.
 *
 * Each function receives a TaskContext (DO storage + env) and runs
 * inside the DO's alarm handler. The DO's single-threaded model
 * guarantees no concurrent execution — no optimistic concurrency needed.
 */

import type {
  Env,
  ProjectItem,
  ActivityEvent,
  AgentRef,
  MentionScanState,
  GitHubScanState,
  GitHubScanRepo,
  GitHubMapState,
  MessageArchive,
} from "../lib/types";
import { STORAGE_KEYS } from "../lib/types";
import {
  STALE_AFTER_MS,
  MENTION_SCAN_COOLDOWN_MS,
  GITHUB_SCAN_COOLDOWN_MS,
  WEBSITE_SCAN_COOLDOWN_MS,
  MAX_ARCHIVED_MESSAGES,
  SEED_GITHUB_MAPPINGS,
  MAX_EVENTS,
} from "../lib/constants";
import { fetchGithubData, parseGithubUrl, deriveStatus } from "./github";
import { matchMention } from "./mentions";
import { addContributor } from "./data";
import {
  isDeploymentUrl,
  extractUrlFromReadme,
  extractUrlFromDescription,
  extractUrlFromMessages,
} from "./websites";

// ---------------------------------------------------------------------------
// Context type — passed to every alarm task
// ---------------------------------------------------------------------------

export interface TaskContext {
  storage: DurableObjectStorage;
  env: Env;
}

export interface TaskResult {
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Read all projects from DO storage in display order */
async function getAllProjects(ctx: TaskContext): Promise<ProjectItem[]> {
  const order = await ctx.storage.get<string[]>(STORAGE_KEYS.projectOrder);
  if (!order || order.length === 0) return [];

  const keys = order.map((id) => STORAGE_KEYS.projectPrefix + id);
  const entries = await ctx.storage.get<ProjectItem>(keys);

  const items: ProjectItem[] = [];
  for (const id of order) {
    const item = entries.get(STORAGE_KEYS.projectPrefix + id);
    if (item) items.push(item);
  }
  return items;
}

/** Save a single project back to DO storage */
async function saveProject(
  ctx: TaskContext,
  item: ProjectItem
): Promise<void> {
  await ctx.storage.put(STORAGE_KEYS.projectPrefix + item.id, item);
}

/** Record an activity event directly in DO storage */
async function recordEvent(
  ctx: TaskContext,
  event: Omit<ActivityEvent, "id" | "timestamp">
): Promise<void> {
  const timestamp = new Date().toISOString();
  const id = "e_" + crypto.randomUUID().slice(0, 8);
  const fullEvent: ActivityEvent = { id, timestamp, ...event };
  const key = `${STORAGE_KEYS.eventPrefix}${timestamp}:${id}`;
  await ctx.storage.put(key, fullEvent);
}

/** Prune events if over the limit */
async function pruneEvents(ctx: TaskContext): Promise<void> {
  const all = await ctx.storage.list({ prefix: STORAGE_KEYS.eventPrefix });
  if (all.size <= MAX_EVENTS) return;

  const toDelete = all.size - MAX_EVENTS;
  const keys: string[] = [];
  let count = 0;
  for (const [key] of all) {
    if (count >= toDelete) break;
    keys.push(key);
    count++;
  }
  if (keys.length > 0) {
    await ctx.storage.delete(keys);
  }
}

/** Build GitHub API request headers */
function githubHeaders(env: Env): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": "aibtc-projects/2.0",
    Accept: "application/vnd.github+json",
  };
  if (env.GITHUB_TOKEN) {
    headers["Authorization"] = `Bearer ${env.GITHUB_TOKEN}`;
  }
  return headers;
}

/** Get the GitHub username → AIBTC agent mapping from DO storage */
async function getGithubMapping(ctx: TaskContext): Promise<GitHubMapState> {
  const state = await ctx.storage.get<GitHubMapState>(STORAGE_KEYS.githubMap);
  if (state?.mapping) return state;
  // First run: seed with known mappings
  const initial: GitHubMapState = { mapping: { ...SEED_GITHUB_MAPPINGS } };
  await ctx.storage.put(STORAGE_KEYS.githubMap, initial);
  return initial;
}

/** Resolve a GitHub username to an AIBTC agent via mapping + API lookup */
async function resolveGithubUser(
  ctx: TaskContext,
  username: string,
  mapping: GitHubMapState
): Promise<AgentRef | null> {
  const btcAddress = mapping.mapping[username.toLowerCase()];
  if (!btcAddress) return null;

  // Check KV agent cache (has native TTL)
  const cacheKey = `roadmap:agent-cache:${btcAddress}`;
  const cached = await ctx.env.ROADMAP_KV.get<{
    btcAddress: string;
    displayName: string;
    agentId: string | null;
  }>(cacheKey, "json");
  if (cached) {
    return {
      btcAddress: cached.btcAddress,
      displayName: cached.displayName,
      agentId: cached.agentId ?? null,
    };
  }

  // Fetch from AIBTC API
  try {
    const res = await fetch(
      `https://aibtc.com/api/agents/${encodeURIComponent(btcAddress)}`,
      { headers: { "User-Agent": "aibtc-projects/2.0" } }
    );
    if (!res.ok) {
      return { btcAddress, displayName: username, agentId: null };
    }
    const data = (await res.json()) as {
      found: boolean;
      agent: {
        btcAddress: string;
        displayName?: string;
        erc8004AgentId?: string;
      };
    };
    if (!data.found) {
      return { btcAddress, displayName: username, agentId: null };
    }
    const agent: AgentRef = {
      btcAddress: data.agent.btcAddress,
      displayName: data.agent.displayName || username,
      agentId: data.agent.erc8004AgentId ?? null,
    };
    // Cache for 1 hour in KV
    await ctx.env.ROADMAP_KV.put(cacheKey, JSON.stringify(agent), {
      expirationTtl: 3600,
    });
    return agent;
  } catch (err) {
    console.error("[resolveGithubUser]", username, err);
    return { btcAddress, displayName: username, agentId: null };
  }
}

/** Get archived messages from DO storage */
async function getArchivedMessages(
  ctx: TaskContext
): Promise<MessageArchive["messages"]> {
  const archive =
    await ctx.storage.get<MessageArchive>(STORAGE_KEYS.messageArchive);
  return archive?.messages ?? [];
}

/** Archive new message events, dedup by timestamp */
async function archiveMessages(
  ctx: TaskContext,
  messageEvents: Array<{
    timestamp: string;
    agent?: { btcAddress: string; displayName: string } | null;
    recipient?: { btcAddress: string; displayName: string } | null;
    messagePreview?: string | null;
  }>
): Promise<number> {
  if (!messageEvents || messageEvents.length === 0) return 0;
  const existing = await getArchivedMessages(ctx);
  const timestamps = new Set(existing.map((m) => m.timestamp));

  let added = 0;
  for (const ev of messageEvents) {
    if (!ev.timestamp || timestamps.has(ev.timestamp)) continue;
    existing.push({
      id: "m_" + crypto.randomUUID().slice(0, 8),
      type: "message",
      timestamp: ev.timestamp,
      agent: ev.agent
        ? {
            btcAddress: ev.agent.btcAddress,
            displayName: ev.agent.displayName,
            agentId: null,
          }
        : null,
      itemId: null,
      itemTitle: null,
      data: {
        messagePreview: ev.messagePreview ?? null,
        recipient: ev.recipient
          ? {
              btcAddress: ev.recipient.btcAddress,
              displayName: ev.recipient.displayName,
            }
          : null,
      },
    });
    timestamps.add(ev.timestamp);
    added++;
  }

  if (added > 0) {
    existing.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    const trimmed = existing.slice(0, MAX_ARCHIVED_MESSAGES);
    await ctx.storage.put(STORAGE_KEYS.messageArchive, {
      messages: trimmed,
    } satisfies MessageArchive);
  }
  return added;
}

/** Get a default GitHubScanRepo entry */
function defaultRepoState(): GitHubScanRepo {
  return {
    lastContributorScanAt: null,
    contributorFails: 0,
    lastEventScanAt: null,
    eventFails: 0,
    lastWebsiteScanAt: null,
    websiteFails: 0,
  };
}

// ---------------------------------------------------------------------------
// Task 1: refreshStaleGithubData
// ---------------------------------------------------------------------------

export async function githubRefresh(ctx: TaskContext): Promise<TaskResult> {
  const items = await getAllProjects(ctx);
  const now = Date.now();
  let refreshedCount = 0;
  const statusChanges: Array<{
    itemId: string;
    itemTitle: string;
    oldStatus: string;
    newStatus: string;
  }> = [];

  for (const item of items) {
    if (!item.githubUrl) continue;
    const fetchedAt = item.githubData?.fetchedAt
      ? new Date(item.githubData.fetchedAt).getTime()
      : 0;
    if (now - fetchedAt < STALE_AFTER_MS) continue;

    const fresh = await fetchGithubData(item.githubUrl, ctx.env);
    if (!fresh) continue;

    // Auto-archive repos that return 404
    if ((fresh as { _notFound?: boolean })._notFound) {
      const fails = (item.githubData?._notFoundCount || 0) + 1;
      if (fails >= 3 && item.githubData?.state !== "archived") {
        item.githubData = {
          ...item.githubData!,
          state: "archived",
          _notFoundCount: fails,
          fetchedAt: new Date().toISOString(),
        };
        item.updatedAt = new Date().toISOString();
        statusChanges.push({
          itemId: item.id,
          itemTitle: item.title,
          oldStatus: deriveStatus(item),
          newStatus: "done",
        });
        console.log(
          `[alarm:github-refresh] auto-archived ${item.githubUrl} after ${fails} 404s`
        );
      } else {
        item.githubData = {
          ...item.githubData!,
          _notFoundCount: fails,
          fetchedAt: new Date().toISOString(),
        };
      }
      await saveProject(ctx, item);
      continue;
    }

    // Track status transitions
    const oldStatus = deriveStatus(item);
    item.githubData = fresh;
    const newStatus = deriveStatus(item);
    if (oldStatus !== newStatus) {
      statusChanges.push({
        itemId: item.id,
        itemTitle: item.title,
        oldStatus,
        newStatus,
      });
    }
    item.updatedAt = new Date().toISOString();
    await saveProject(ctx, item);
    refreshedCount++;
  }

  // Record status transition events
  for (const ev of statusChanges) {
    await recordEvent(ctx, {
      type: "item.status_synced",
      agent: null,
      itemId: ev.itemId,
      itemTitle: ev.itemTitle,
      data: {
        oldStatus: ev.oldStatus,
        newStatus: ev.newStatus,
        reason: "github_state",
      },
    });
  }

  console.log(
    `[alarm:github-refresh] refreshed ${refreshedCount}/${items.length}, ${statusChanges.length} status changes`
  );
  return { refreshedCount, statusChanges: statusChanges.length };
}

// ---------------------------------------------------------------------------
// Task 2: scanForMentions
// ---------------------------------------------------------------------------

export async function mentionScan(ctx: TaskContext): Promise<TaskResult> {
  // Check cooldown
  const scanState =
    (await ctx.storage.get<MentionScanState>(STORAGE_KEYS.mentionScan)) ?? {
      lastScanAt: null,
      processedIds: [],
    };
  const lastScan = scanState.lastScanAt
    ? new Date(scanState.lastScanAt).getTime()
    : 0;
  if (Date.now() - lastScan < MENTION_SCAN_COOLDOWN_MS) {
    console.log("[alarm:mention-scan] skipping — cooldown active");
    return { scanned: false, reason: "cooldown" };
  }

  const processedIds = new Set(scanState.processedIds);

  // Fetch AIBTC network activity
  let activityEvents: Array<{
    type: string;
    timestamp: string;
    messagePreview?: string;
    agent?: { btcAddress: string; displayName: string } | null;
    recipient?: { btcAddress: string; displayName: string } | null;
  }>;
  try {
    const res = await fetch("https://aibtc.com/api/activity", {
      headers: { "User-Agent": "aibtc-projects/2.0" },
    });
    if (!res.ok) {
      console.error("[alarm:mention-scan] API returned", res.status);
      return { scanned: false, reason: "api_error" };
    }
    const body = (await res.json()) as { events?: typeof activityEvents };
    activityEvents = body.events || [];
  } catch (err) {
    console.error("[alarm:mention-scan] activity fetch failed", err);
    return { scanned: false, reason: "fetch_error" };
  }

  // Archive message events
  const messageEvents = activityEvents.filter(
    (e) => e.type === "message" && e.messagePreview
  );
  await archiveMessages(ctx, messageEvents);

  // Filter to unprocessed message events with preview text
  const newEvents = activityEvents.filter(
    (e) =>
      e.type === "message" &&
      e.messagePreview &&
      !processedIds.has(e.timestamp)
  );

  if (newEvents.length === 0) {
    // Update scan time
    await ctx.storage.put(STORAGE_KEYS.mentionScan, {
      lastScanAt: new Date().toISOString(),
      processedIds: [...processedIds].slice(-500),
    } satisfies MentionScanState);
    console.log("[alarm:mention-scan] no new events");
    return { scanned: true, newMentions: 0 };
  }

  const items = await getAllProjects(ctx);
  let changed = false;
  const mentionEvents: Array<{
    itemId: string;
    itemTitle: string;
    agent: AgentRef | null;
    matchType: string;
    messagePreview: string | null;
    recipient: { btcAddress: string; displayName: string } | null;
  }> = [];

  for (const ev of newEvents) {
    const preview = (ev.messagePreview || "").toLowerCase();
    processedIds.add(ev.timestamp);

    for (const item of items) {
      const matchResult = matchMention(preview, item);
      if (matchResult) {
        if (!item.mentions) item.mentions = { count: 0 };
        item.mentions.count += 1;
        // Auto-add mentioning agent as contributor
        if (ev.agent?.btcAddress) {
          addContributor(item, {
            btcAddress: ev.agent.btcAddress,
            displayName: ev.agent.displayName,
            agentId: null,
          });
        }
        changed = true;
        mentionEvents.push({
          itemId: item.id,
          itemTitle: item.title,
          agent: ev.agent
            ? {
                btcAddress: ev.agent.btcAddress,
                displayName: ev.agent.displayName,
                agentId: null,
              }
            : null,
          matchType: matchResult,
          messagePreview: ev.messagePreview ?? null,
          recipient: ev.recipient ?? null,
        });
      }
    }
  }

  // Save updated projects
  if (changed) {
    for (const item of items) {
      await saveProject(ctx, item);
    }
  }

  // Record mention events
  for (const me of mentionEvents) {
    await recordEvent(ctx, {
      type: "item.mentioned",
      agent: me.agent,
      itemId: me.itemId,
      itemTitle: me.itemTitle,
      data: {
        matchType: me.matchType,
        messagePreview: me.messagePreview,
        recipient: me.recipient,
      },
    });
  }

  // Update scan state
  await ctx.storage.put(STORAGE_KEYS.mentionScan, {
    lastScanAt: new Date().toISOString(),
    processedIds: [...processedIds].slice(-500),
  } satisfies MentionScanState);

  await pruneEvents(ctx);

  console.log(
    `[alarm:mention-scan] processed ${newEvents.length} events, ${mentionEvents.length} mentions`
  );
  return { scanned: true, newMentions: mentionEvents.length };
}

// ---------------------------------------------------------------------------
// Task 3: scanGithubContributors
// ---------------------------------------------------------------------------

export async function contributorScan(ctx: TaskContext): Promise<TaskResult> {
  const scanState =
    (await ctx.storage.get<GitHubScanState>(STORAGE_KEYS.githubScan)) ?? {
      version: 1,
      repos: {},
    };
  const mapping = await getGithubMapping(ctx);
  const items = await getAllProjects(ctx);
  const now = Date.now();
  let changed = false;
  let newContributors = 0;
  const scannedRepos: string[] = [];
  const unmappedUsers: string[] = [];
  const errors: string[] = [];

  for (const item of items) {
    const parsed = parseGithubUrl(item.githubUrl);
    if (!parsed || parsed.type !== "repo") continue;
    if (item.githubData?.state === "archived") continue;

    const repoPath = `${parsed.owner}/${parsed.repo}`;
    const repoState: GitHubScanRepo =
      scanState.repos[repoPath] ?? defaultRepoState();
    const lastScan = repoState.lastContributorScanAt
      ? new Date(repoState.lastContributorScanAt).getTime()
      : 0;
    // Backoff: after 3+ consecutive failures, wait 1 hour
    const cooldown =
      repoState.contributorFails >= 3
        ? 60 * 60 * 1000
        : GITHUB_SCAN_COOLDOWN_MS;
    if (now - lastScan < cooldown) continue;

    try {
      const res = await fetch(
        `https://api.github.com/repos/${repoPath}/contributors?per_page=30`,
        { headers: githubHeaders(ctx.env) }
      );
      if (!res.ok) {
        errors.push(`${repoPath}: HTTP ${res.status}`);
        scanState.repos[repoPath] = {
          ...repoState,
          lastContributorScanAt: new Date().toISOString(),
          contributorFails: repoState.contributorFails + 1,
        };
        continue;
      }
      const contributors = (await res.json()) as Array<{
        login?: string;
        type?: string;
      }>;
      if (!Array.isArray(contributors)) {
        errors.push(`${repoPath}: non-array response`);
        scanState.repos[repoPath] = {
          ...repoState,
          lastContributorScanAt: new Date().toISOString(),
          contributorFails: repoState.contributorFails + 1,
        };
        continue;
      }

      for (const c of contributors) {
        if (!c.login || c.type === "Bot") continue;
        const agent = await resolveGithubUser(ctx, c.login, mapping);
        if (agent) {
          const before = (item.contributors || []).length;
          addContributor(item, agent);
          if ((item.contributors || []).length > before) {
            changed = true;
            newContributors++;
          }
        } else if (!unmappedUsers.includes(c.login)) {
          unmappedUsers.push(c.login);
        }
      }

      scanState.repos[repoPath] = {
        ...repoState,
        lastContributorScanAt: new Date().toISOString(),
        contributorFails: 0,
      };
      scannedRepos.push(repoPath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`${repoPath}: ${message}`);
      scanState.repos[repoPath] = {
        ...repoState,
        lastContributorScanAt: new Date().toISOString(),
        contributorFails: repoState.contributorFails + 1,
      };
    }
  }

  // Save updated projects
  if (changed) {
    for (const item of items) {
      await saveProject(ctx, item);
    }
  }
  await ctx.storage.put(STORAGE_KEYS.githubScan, scanState);

  console.log(
    `[alarm:contributor-scan] scanned ${scannedRepos.length} repos, ${newContributors} new contributors`
  );
  return {
    scannedRepos: scannedRepos.length,
    newContributors,
    unmappedUsers,
    errors,
  };
}

// ---------------------------------------------------------------------------
// Task 4: scanGithubEvents (merged PRs → deliverables)
// ---------------------------------------------------------------------------

export async function prScan(ctx: TaskContext): Promise<TaskResult> {
  const scanState =
    (await ctx.storage.get<GitHubScanState>(STORAGE_KEYS.githubScan)) ?? {
      version: 1,
      repos: {},
    };
  const mapping = await getGithubMapping(ctx);
  const items = await getAllProjects(ctx);
  const now = Date.now();
  let changed = false;
  let newDeliverables = 0;
  let newContributors = 0;
  const scannedRepos: string[] = [];
  const errors: string[] = [];

  for (const item of items) {
    const parsed = parseGithubUrl(item.githubUrl);
    if (!parsed || parsed.type !== "repo") continue;
    if (item.githubData?.state === "archived") continue;

    const repoPath = `${parsed.owner}/${parsed.repo}`;
    const repoState: GitHubScanRepo =
      scanState.repos[repoPath] ?? defaultRepoState();
    const lastScan = repoState.lastEventScanAt
      ? new Date(repoState.lastEventScanAt).getTime()
      : 0;
    const cooldown =
      repoState.eventFails >= 3 ? 60 * 60 * 1000 : GITHUB_SCAN_COOLDOWN_MS;
    if (now - lastScan < cooldown) continue;

    try {
      const res = await fetch(
        `https://api.github.com/repos/${repoPath}/pulls?state=closed&sort=updated&direction=desc&per_page=10`,
        { headers: githubHeaders(ctx.env) }
      );
      if (!res.ok) {
        errors.push(`${repoPath}: HTTP ${res.status}`);
        scanState.repos[repoPath] = {
          ...repoState,
          lastEventScanAt: new Date().toISOString(),
          eventFails: repoState.eventFails + 1,
        };
        continue;
      }
      const pulls = (await res.json()) as Array<{
        merged_at?: string | null;
        html_url: string;
        title: string;
        user?: { login?: string; type?: string };
      }>;

      for (const pr of pulls) {
        if (!pr.merged_at) continue;
        // Skip bot PRs
        if (
          pr.user?.type === "Bot" ||
          pr.user?.login?.endsWith("[bot]")
        )
          continue;
        // Only process PRs merged since last scan
        if (
          lastScan > 0 &&
          new Date(pr.merged_at).getTime() <= lastScan
        )
          continue;

        // Check for duplicate deliverable
        if (!Array.isArray(item.deliverables)) item.deliverables = [];
        const alreadyExists = item.deliverables.some(
          (d) => d.url === pr.html_url
        );
        if (alreadyExists) continue;

        // Resolve PR author
        const agent = pr.user?.login
          ? await resolveGithubUser(ctx, pr.user.login, mapping)
          : null;

        item.deliverables.push({
          title: pr.title,
          url: pr.html_url,
          addedBy: agent || {
            displayName: pr.user?.login || "unknown",
            btcAddress: "",
            agentId: null,
          },
          addedAt: new Date().toISOString(),
        });
        changed = true;
        newDeliverables++;

        // Add PR author as contributor
        if (agent) {
          const before = (item.contributors || []).length;
          addContributor(item, agent);
          if ((item.contributors || []).length > before) newContributors++;
        }

        // Record event
        await recordEvent(ctx, {
          type: "item.deliverable_added",
          agent: agent || null,
          itemId: item.id,
          itemTitle: item.title,
          data: { title: pr.title, url: pr.html_url, source: "github_pr" },
        });
      }

      scanState.repos[repoPath] = {
        ...repoState,
        lastEventScanAt: new Date().toISOString(),
        eventFails: 0,
      };
      scannedRepos.push(repoPath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`${repoPath}: ${message}`);
      scanState.repos[repoPath] = {
        ...repoState,
        lastEventScanAt: new Date().toISOString(),
        eventFails: repoState.eventFails + 1,
      };
    }
  }

  // Save updated projects
  if (changed) {
    for (const item of items) {
      await saveProject(ctx, item);
    }
  }
  await ctx.storage.put(STORAGE_KEYS.githubScan, scanState);
  await pruneEvents(ctx);

  console.log(
    `[alarm:pr-scan] scanned ${scannedRepos.length} repos, ${newDeliverables} deliverables, ${newContributors} contributors`
  );
  return {
    scannedRepos: scannedRepos.length,
    newDeliverables,
    newContributors,
    errors,
  };
}

// ---------------------------------------------------------------------------
// Task 5: discoverWebsites
// ---------------------------------------------------------------------------

const CURRENT_WEBSITE_FILTER_VERSION = 5;

export async function websiteDiscovery(ctx: TaskContext): Promise<TaskResult> {
  const scanState =
    (await ctx.storage.get<GitHubScanState>(STORAGE_KEYS.githubScan)) ?? {
      version: 1,
      repos: {},
    };

  // Reset website scan cooldowns when filter rules change
  if (
    !scanState.websiteFilterVersion ||
    scanState.websiteFilterVersion < CURRENT_WEBSITE_FILTER_VERSION
  ) {
    for (const rp of Object.keys(scanState.repos)) {
      const repo = scanState.repos[rp];
      if (repo) {
        repo.lastWebsiteScanAt = null;
        repo.websiteFails = 0;
      }
    }
    scanState.websiteFilterVersion = CURRENT_WEBSITE_FILTER_VERSION;
  }

  const items = await getAllProjects(ctx);
  const now = Date.now();
  let changed = false;
  let discovered = 0;
  const scannedRepos: string[] = [];
  const errors: string[] = [];
  let archivedMessages: MessageArchive["messages"] | null = null; // lazy-load

  // Build set of already-claimed website URLs
  const claimedUrls = new Set<string>();
  for (const it of items) {
    if (it.website?.url) claimedUrls.add(it.website.url);
  }

  for (const item of items) {
    // Keep homepage-sourced websites in sync with githubData.homepage
    if (
      item.website?.source === "homepage" &&
      item.githubData?.homepage &&
      item.website.url !== item.githubData.homepage
    ) {
      item.website.url = item.githubData.homepage;
      item.website.discoveredAt = new Date().toISOString();
      changed = true;
    }

    // Re-evaluate existing websites that now fail the noise filter or are claimed by another
    const shouldClear =
      item.website &&
      (isDeploymentUrl(item.website.url) === 0 ||
        (item.website.source !== "homepage" &&
          items.some(
            (other) =>
              other !== item &&
              other.website?.url === item.website?.url &&
              other.website?.source === "homepage"
          )));
    if (shouldClear && item.website) {
      claimedUrls.delete(item.website.url);
      item.website = null;
      changed = true;
      // Reset cooldown so this repo gets re-scanned immediately
      const p = parseGithubUrl(item.githubUrl);
      if (p) {
        const rp = `${p.owner}/${p.repo}`;
        const repo = scanState.repos[rp];
        if (repo) {
          repo.lastWebsiteScanAt = null;
        }
      }
    }

    // Skip if already discovered
    if (item.website) continue;

    const parsed = parseGithubUrl(item.githubUrl);
    if (!parsed || parsed.type !== "repo") continue;
    if (item.githubData?.state === "archived") continue;

    const repoPath = `${parsed.owner}/${parsed.repo}`;
    const repoState: GitHubScanRepo =
      scanState.repos[repoPath] ?? defaultRepoState();
    const lastScan = repoState.lastWebsiteScanAt
      ? new Date(repoState.lastWebsiteScanAt).getTime()
      : 0;
    const cooldown =
      repoState.websiteFails >= 3
        ? 6 * 60 * 60 * 1000
        : WEBSITE_SCAN_COOLDOWN_MS;
    if (now - lastScan < cooldown) continue;

    let url: string | null = null;
    let source: string | null = null;

    // Priority 1: GitHub homepage
    if (
      item.githubData?.homepage &&
      isDeploymentUrl(item.githubData.homepage) > 0
    ) {
      url = item.githubData.homepage;
      source = "homepage";
    }

    // Priority 2: GitHub description
    if (!url) {
      const descUrl = extractUrlFromDescription(
        item.githubData?.title,
        claimedUrls
      );
      if (descUrl) {
        url = descUrl;
        source = "description";
      }
    }

    // Priority 3: README (API call)
    if (!url) {
      try {
        const res = await fetch(
          `https://api.github.com/repos/${repoPath}/readme`,
          {
            headers: {
              ...githubHeaders(ctx.env),
              Accept: "application/vnd.github.raw+json",
            },
          }
        );
        if (res.ok) {
          const readmeText = await res.text();
          const readmeUrl = extractUrlFromReadme(readmeText, claimedUrls);
          if (readmeUrl) {
            url = readmeUrl;
            source = "readme";
          }
        }
      } catch (err) {
        console.error(
          "[alarm:website-discovery] README fetch failed",
          repoPath,
          err
        );
        errors.push(`${repoPath}: README fetch failed`);
        scanState.repos[repoPath] = {
          ...repoState,
          lastWebsiteScanAt: new Date().toISOString(),
          websiteFails: repoState.websiteFails + 1,
        };
        continue;
      }
    }

    // Priority 4: Deliverable URLs
    if (!url) {
      for (const d of item.deliverables || []) {
        if (!d.url || isDeploymentUrl(d.url) === 0) continue;
        try {
          if (
            new Set(["aibtc-projects.pages.dev"]).has(
              new URL(d.url).hostname.toLowerCase()
            )
          )
            continue;
        } catch {
          /* skip invalid URLs */
        }
        url = d.url;
        source = "deliverable";
        break;
      }
    }

    // Priority 5: Message archive
    if (!url) {
      if (archivedMessages === null) {
        archivedMessages = await getArchivedMessages(ctx);
      }
      // Map ActivityEvent[] to the shape extractUrlFromMessages expects
      const mapped = archivedMessages.map((m) => ({
        messagePreview: (m.data?.messagePreview as string) ?? null,
      }));
      const msgUrl = extractUrlFromMessages(mapped, item);
      if (msgUrl) {
        url = msgUrl;
        source = "message";
      }
    }

    // Skip if URL is already claimed by another project
    if (url && claimedUrls.has(url)) url = null;

    if (url && source) {
      item.website = { url, source, discoveredAt: new Date().toISOString() };
      item.updatedAt = new Date().toISOString();
      claimedUrls.add(url);
      changed = true;
      discovered++;
    }

    scanState.repos[repoPath] = {
      ...repoState,
      lastWebsiteScanAt: new Date().toISOString(),
      websiteFails: 0,
    };
    scannedRepos.push(repoPath);
  }

  // Save updated projects
  if (changed) {
    for (const item of items) {
      await saveProject(ctx, item);
    }
  }
  await ctx.storage.put(STORAGE_KEYS.githubScan, scanState);

  console.log(
    `[alarm:website-discovery] scanned ${scannedRepos.length} repos, discovered ${discovered} websites`
  );
  return { scannedRepos: scannedRepos.length, discovered, errors };
}

// ---------------------------------------------------------------------------
// Task 6: backfillMentions
// ---------------------------------------------------------------------------

export async function backfillMentionTask(
  ctx: TaskContext
): Promise<TaskResult> {
  // Read all events from DO storage
  const entries = await ctx.storage.list<ActivityEvent>({
    prefix: STORAGE_KEYS.eventPrefix,
  });

  // Find mention events missing messagePreview
  const mentionEntries: Array<{ key: string; event: ActivityEvent }> = [];
  for (const [key, event] of entries) {
    if (
      event.type === "item.mentioned" &&
      !event.data?.messagePreview
    ) {
      mentionEntries.push({ key, event });
    }
  }

  if (mentionEntries.length === 0) {
    console.log("[alarm:backfill-mentions] no events to backfill");
    return { backfilled: 0, total: 0 };
  }

  // Fetch AIBTC activity for matching
  let activityEvents: Array<{
    type: string;
    timestamp: string;
    messagePreview?: string;
    agent?: { btcAddress: string; displayName: string } | null;
    recipient?: { btcAddress: string; displayName: string } | null;
  }>;
  try {
    const res = await fetch("https://aibtc.com/api/activity", {
      headers: { "User-Agent": "aibtc-projects/2.0" },
    });
    if (!res.ok) {
      return { backfilled: 0, error: "activity_api_error" };
    }
    const body = (await res.json()) as { events?: typeof activityEvents };
    activityEvents = (body.events || []).filter(
      (e) => e.type === "message" && e.messagePreview
    );
  } catch (err) {
    console.error("[alarm:backfill-mentions] activity fetch failed", err);
    return { backfilled: 0, error: "fetch_error" };
  }

  if (activityEvents.length === 0) {
    return { backfilled: 0, total: mentionEntries.length };
  }

  // Load items for matching
  const items = await getAllProjects(ctx);
  let backfilled = 0;

  for (const { key, event } of mentionEntries) {
    const item = items.find((i) => i.id === event.itemId);
    if (!item) continue;

    // Find a matching activity event from the same agent
    const senderAddr = event.agent?.btcAddress;
    const matchIdx = activityEvents.findIndex((ae) => {
      if (senderAddr && ae.agent?.btcAddress !== senderAddr) return false;
      const preview = (ae.messagePreview || "").toLowerCase();
      return matchMention(preview, item) !== null;
    });

    if (matchIdx !== -1) {
      const match = activityEvents[matchIdx]!;
      event.data = {
        ...event.data,
        messagePreview: match.messagePreview,
      };
      if (match.recipient) {
        event.data.recipient = {
          btcAddress: match.recipient.btcAddress,
          displayName: match.recipient.displayName,
        };
      }
      // Save updated event back to DO storage
      await ctx.storage.put(key, event);
      backfilled++;
      // Remove matched event so it doesn't match again
      activityEvents.splice(matchIdx, 1);
    }
  }

  console.log(
    `[alarm:backfill-mentions] backfilled ${backfilled}/${mentionEntries.length}`
  );
  return { backfilled, total: mentionEntries.length };
}

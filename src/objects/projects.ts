import { DurableObject } from "cloudflare:workers";
import type {
  Env,
  ProjectItem,
  ActivityEvent,
  AgentRef,
  AlarmTask,
  AlarmMeta,
  MentionScanState,
  GitHubScanState,
  GitHubMapState,
  MessageArchive,
  DOResult,
  RoadmapData,
} from "../lib/types";
import {
  ALARM_CHAIN,
  ALARM_SCHEDULE,
  STORAGE_KEYS,
} from "../lib/types";
import { KV_KEY, MAX_EVENTS, SEED_GITHUB_MAPPINGS } from "../lib/constants";

const SCHEMA_VERSION = 1;
const MAX_EVENTS_IN_DO = MAX_EVENTS;

/**
 * ProjectsDurableObject — structured storage for all project data.
 *
 * Replaces the single KV blob (roadmap:items) with per-item DO storage keys.
 * DO's single-threaded model provides proper write serialization — no more
 * optimistic concurrency / writeVersion needed.
 *
 * Storage key scheme:
 *   project:{id}           — individual ProjectItem
 *   meta:projectOrder      — string[] of project IDs (display order)
 *   meta:schemaVersion     — number
 *   meta:migrated          — boolean
 *   meta:alarm             — AlarmMeta
 *   event:{timestamp}:{id} — ActivityEvent (lexicographic sort = chronological)
 *   scan:mentions          — MentionScanState
 *   scan:github            — GitHubScanState
 *   scan:github-map        — GitHubMapState
 *   scan:messages          — MessageArchive
 */
export class ProjectsDurableObject extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  // -------------------------------------------------------------------------
  // Fetch handler — routes RPC-style requests
  // -------------------------------------------------------------------------

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    try {
      // Health
      if (path === "/health" && method === "GET") {
        return this.handleHealth();
      }

      // Migration
      if (path === "/migrate" && method === "POST") {
        return this.handleMigrate(request);
      }

      // Projects CRUD
      if (path === "/projects" && method === "GET") {
        return this.handleListProjects();
      }
      if (path === "/projects" && method === "POST") {
        return this.handleCreateProject(request);
      }
      if (path.startsWith("/projects/") && method === "GET") {
        const id = path.slice("/projects/".length);
        return this.handleGetProject(id);
      }
      if (path.startsWith("/projects/") && method === "PUT") {
        const id = path.slice("/projects/".length);
        return this.handleUpdateProject(id, request);
      }
      if (path.startsWith("/projects/") && method === "DELETE") {
        const id = path.slice("/projects/".length);
        return this.handleDeleteProject(id);
      }

      // Reorder
      if (path === "/reorder" && method === "POST") {
        return this.handleReorder(request);
      }

      // Events
      if (path === "/events" && method === "GET") {
        return this.handleListEvents(url);
      }
      if (path === "/events" && method === "POST") {
        return this.handleRecordEvent(request);
      }

      // Scan state
      if (path === "/scan/mentions" && method === "GET") {
        return this.handleGetScanState<MentionScanState>(
          STORAGE_KEYS.mentionScan,
          { lastScanAt: null, processedIds: [] }
        );
      }
      if (path === "/scan/mentions" && method === "PUT") {
        return this.handlePutScanState<MentionScanState>(
          STORAGE_KEYS.mentionScan,
          request
        );
      }
      if (path === "/scan/github" && method === "GET") {
        return this.handleGetScanState<GitHubScanState>(
          STORAGE_KEYS.githubScan,
          { version: 1, repos: {} }
        );
      }
      if (path === "/scan/github" && method === "PUT") {
        return this.handlePutScanState<GitHubScanState>(
          STORAGE_KEYS.githubScan,
          request
        );
      }
      if (path === "/scan/github-map" && method === "GET") {
        return this.handleGetGitHubMap();
      }
      if (path === "/scan/github-map" && method === "PUT") {
        return this.handlePutScanState<GitHubMapState>(
          STORAGE_KEYS.githubMap,
          request
        );
      }
      if (path === "/scan/messages" && method === "GET") {
        return this.handleGetScanState<MessageArchive>(
          STORAGE_KEYS.messageArchive,
          { messages: [] }
        );
      }
      if (path === "/scan/messages" && method === "PUT") {
        return this.handlePutScanState<MessageArchive>(
          STORAGE_KEYS.messageArchive,
          request
        );
      }

      // Alarm management
      if (path === "/alarms/start" && method === "POST") {
        return this.handleStartAlarms();
      }
      if (path === "/alarms/status" && method === "GET") {
        return this.handleAlarmStatus();
      }

      return Response.json({ error: "Not found" }, { status: 404 });
    } catch (err) {
      console.error("[ProjectsDO]", path, err);
      const message = err instanceof Error ? err.message : "Internal error";
      return Response.json({ ok: false, error: message }, { status: 500 });
    }
  }

  // -------------------------------------------------------------------------
  // Alarm handler — background task chain
  // -------------------------------------------------------------------------

  async alarm(): Promise<void> {
    const meta = await this.getAlarmMeta();
    const nextTask = this.getNextAlarmTask(meta.lastTask);

    console.log(`[alarm] running task: ${nextTask}`);
    const start = Date.now();

    try {
      await this.runAlarmTask(nextTask);
    } catch (err) {
      console.error(`[alarm] task ${nextTask} failed:`, err);
    }

    const durationMs = Date.now() - start;

    // Update meta
    meta.lastTask = nextTask;
    meta.lastRunAt = new Date().toISOString();
    meta.taskHistory.push({ task: nextTask, ranAt: meta.lastRunAt, durationMs });
    // Keep last 50 entries
    if (meta.taskHistory.length > 50) {
      meta.taskHistory = meta.taskHistory.slice(-50);
    }
    await this.ctx.storage.put(STORAGE_KEYS.alarmMeta, meta);

    // Schedule next alarm — use the next task's interval
    const nextNextTask = this.getNextAlarmTask(nextTask);
    const intervalMs = ALARM_SCHEDULE[nextNextTask] * 60 * 1000;
    await this.ctx.storage.setAlarm(Date.now() + intervalMs);
  }

  // -------------------------------------------------------------------------
  // Health
  // -------------------------------------------------------------------------

  private async handleHealth(): Promise<Response> {
    const migrated = await this.ctx.storage.get<boolean>(STORAGE_KEYS.migrated);
    const version = await this.ctx.storage.get<number>(STORAGE_KEYS.schemaVersion);
    const order = await this.ctx.storage.get<string[]>(STORAGE_KEYS.projectOrder);
    const alarm = await this.ctx.storage.getAlarm();

    return Response.json({
      ok: true,
      schemaVersion: version ?? null,
      migrated: migrated ?? false,
      projectCount: order?.length ?? 0,
      alarmScheduled: alarm !== null,
      alarmAt: alarm ? new Date(alarm).toISOString() : null,
    });
  }

  // -------------------------------------------------------------------------
  // KV → DO Migration
  // -------------------------------------------------------------------------

  private async handleMigrate(request: Request): Promise<Response> {
    const already = await this.ctx.storage.get<boolean>(STORAGE_KEYS.migrated);
    if (already) {
      return Response.json({
        ok: true,
        data: { skipped: true, reason: "Already migrated" },
      } satisfies DOResult<{ skipped: boolean; reason: string }>);
    }

    // Read KV data passed in the request body (worker sends it)
    const body = (await request.json()) as { kvData?: RoadmapData };
    const kvData = body.kvData;

    if (!kvData || !Array.isArray(kvData.items)) {
      return Response.json({
        ok: false,
        error: "No valid KV data provided",
      } satisfies DOResult<never>, { status: 400 });
    }

    // Use a transaction for atomicity
    await this.ctx.storage.transaction(async (txn) => {
      const order: string[] = [];

      for (const item of kvData.items) {
        const key = STORAGE_KEYS.projectPrefix + item.id;
        await txn.put(key, item);
        order.push(item.id);
      }

      await txn.put(STORAGE_KEYS.projectOrder, order);
      await txn.put(STORAGE_KEYS.schemaVersion, SCHEMA_VERSION);
      await txn.put(STORAGE_KEYS.migrated, true);
    });

    // Seed GitHub map
    const existingMap = await this.ctx.storage.get<GitHubMapState>(
      STORAGE_KEYS.githubMap
    );
    if (!existingMap) {
      await this.ctx.storage.put(STORAGE_KEYS.githubMap, {
        mapping: { ...SEED_GITHUB_MAPPINGS },
      } satisfies GitHubMapState);
    }

    return Response.json({
      ok: true,
      data: { migrated: kvData.items.length, schemaVersion: SCHEMA_VERSION },
    } satisfies DOResult<{ migrated: number; schemaVersion: number }>);
  }

  // -------------------------------------------------------------------------
  // Projects CRUD
  // -------------------------------------------------------------------------

  private async handleListProjects(): Promise<Response> {
    const order = await this.ctx.storage.get<string[]>(
      STORAGE_KEYS.projectOrder
    );
    if (!order || order.length === 0) {
      return Response.json({ ok: true, data: [] } satisfies DOResult<ProjectItem[]>);
    }

    // Batch get all projects
    const keys = order.map((id) => STORAGE_KEYS.projectPrefix + id);
    const entries = await this.ctx.storage.get<ProjectItem>(keys);

    const items: ProjectItem[] = [];
    for (const id of order) {
      const item = entries.get(STORAGE_KEYS.projectPrefix + id);
      if (item) items.push(item);
    }

    return Response.json({ ok: true, data: items } satisfies DOResult<ProjectItem[]>);
  }

  private async handleGetProject(id: string): Promise<Response> {
    const item = await this.ctx.storage.get<ProjectItem>(
      STORAGE_KEYS.projectPrefix + id
    );
    if (!item) {
      return Response.json(
        { ok: false, error: "Project not found" } satisfies DOResult<never>,
        { status: 404 }
      );
    }
    return Response.json({ ok: true, data: item } satisfies DOResult<ProjectItem>);
  }

  private async handleCreateProject(request: Request): Promise<Response> {
    const item = (await request.json()) as ProjectItem;

    if (!item.id || !item.title || !item.githubUrl) {
      return Response.json(
        { ok: false, error: "Missing required fields: id, title, githubUrl" } satisfies DOResult<never>,
        { status: 400 }
      );
    }

    // Check duplicate
    const existing = await this.ctx.storage.get<ProjectItem>(
      STORAGE_KEYS.projectPrefix + item.id
    );
    if (existing) {
      return Response.json(
        { ok: false, error: "Project ID already exists" } satisfies DOResult<never>,
        { status: 409 }
      );
    }

    await this.ctx.storage.transaction(async (txn) => {
      await txn.put(STORAGE_KEYS.projectPrefix + item.id, item);

      const order =
        (await txn.get<string[]>(STORAGE_KEYS.projectOrder)) ?? [];
      order.push(item.id);
      await txn.put(STORAGE_KEYS.projectOrder, order);
    });

    return Response.json(
      { ok: true, data: item } satisfies DOResult<ProjectItem>,
      { status: 201 }
    );
  }

  private async handleUpdateProject(
    id: string,
    request: Request
  ): Promise<Response> {
    const updates = (await request.json()) as Partial<ProjectItem>;
    const key = STORAGE_KEYS.projectPrefix + id;

    const existing = await this.ctx.storage.get<ProjectItem>(key);
    if (!existing) {
      return Response.json(
        { ok: false, error: "Project not found" } satisfies DOResult<never>,
        { status: 404 }
      );
    }

    const updated: ProjectItem = {
      ...existing,
      ...updates,
      id: existing.id, // Never allow ID change
      createdAt: existing.createdAt, // Never allow createdAt change
      updatedAt: new Date().toISOString(),
    };

    await this.ctx.storage.put(key, updated);

    return Response.json({ ok: true, data: updated } satisfies DOResult<ProjectItem>);
  }

  private async handleDeleteProject(id: string): Promise<Response> {
    const key = STORAGE_KEYS.projectPrefix + id;
    const existing = await this.ctx.storage.get<ProjectItem>(key);
    if (!existing) {
      return Response.json(
        { ok: false, error: "Project not found" } satisfies DOResult<never>,
        { status: 404 }
      );
    }

    await this.ctx.storage.transaction(async (txn) => {
      await txn.delete(key);

      const order =
        (await txn.get<string[]>(STORAGE_KEYS.projectOrder)) ?? [];
      const filtered = order.filter((pid) => pid !== id);
      await txn.put(STORAGE_KEYS.projectOrder, filtered);
    });

    return Response.json({ ok: true, data: existing } satisfies DOResult<ProjectItem>);
  }

  // -------------------------------------------------------------------------
  // Reorder
  // -------------------------------------------------------------------------

  private async handleReorder(request: Request): Promise<Response> {
    const body = (await request.json()) as { order: string[] };
    if (!Array.isArray(body.order)) {
      return Response.json(
        { ok: false, error: "order must be a string array" } satisfies DOResult<never>,
        { status: 400 }
      );
    }

    // Validate all IDs exist
    const currentOrder =
      (await this.ctx.storage.get<string[]>(STORAGE_KEYS.projectOrder)) ?? [];
    const currentSet = new Set(currentOrder);
    const newSet = new Set(body.order);

    // Must contain exactly the same IDs
    if (
      currentSet.size !== newSet.size ||
      ![...currentSet].every((id) => newSet.has(id))
    ) {
      return Response.json(
        {
          ok: false,
          error: "New order must contain exactly the same project IDs",
        } satisfies DOResult<never>,
        { status: 400 }
      );
    }

    await this.ctx.storage.put(STORAGE_KEYS.projectOrder, body.order);

    return Response.json({
      ok: true,
      data: body.order,
    } satisfies DOResult<string[]>);
  }

  // -------------------------------------------------------------------------
  // Events (Activity Feed)
  // -------------------------------------------------------------------------

  private async handleListEvents(url: URL): Promise<Response> {
    const limit = Math.min(
      parseInt(url.searchParams.get("limit") ?? "50", 10),
      MAX_EVENTS_IN_DO
    );
    const typeFilter = url.searchParams.get("type");
    const itemIdFilter = url.searchParams.get("itemId");
    const cursor = url.searchParams.get("cursor"); // event key for pagination

    // List events in reverse chronological order (newest first)
    const opts: DurableObjectListOptions = {
      prefix: STORAGE_KEYS.eventPrefix,
      reverse: true,
      limit: limit * 2, // Over-fetch to account for filtering
    };
    if (cursor) {
      opts.startAfter = cursor;
    }

    const entries = await this.ctx.storage.list<ActivityEvent>(opts);
    let events: ActivityEvent[] = [];
    let lastKey: string | null = null;

    for (const [key, event] of entries) {
      if (typeFilter && event.type !== typeFilter) continue;
      if (itemIdFilter && event.itemId !== itemIdFilter) continue;
      events.push(event);
      lastKey = key;
      if (events.length >= limit) break;
    }

    return Response.json({
      ok: true,
      data: {
        events,
        total: events.length,
        cursor: events.length >= limit ? lastKey : null,
      },
    });
  }

  private async handleRecordEvent(request: Request): Promise<Response> {
    const event = (await request.json()) as Omit<ActivityEvent, "id" | "timestamp">;
    const now = new Date();
    const timestamp = now.toISOString();
    const id = "e_" + crypto.randomUUID().slice(0, 8);

    const fullEvent: ActivityEvent = {
      id,
      timestamp,
      ...event,
    };

    // Key format: event:{ISO timestamp}:{id} — lexicographic order = chronological
    const key = `${STORAGE_KEYS.eventPrefix}${timestamp}:${id}`;
    await this.ctx.storage.put(key, fullEvent);

    // Prune old events if over limit
    await this.pruneEvents();

    return Response.json(
      { ok: true, data: fullEvent } satisfies DOResult<ActivityEvent>,
      { status: 201 }
    );
  }

  private async pruneEvents(): Promise<void> {
    // Count events
    const all = await this.ctx.storage.list({
      prefix: STORAGE_KEYS.eventPrefix,
    });
    if (all.size <= MAX_EVENTS_IN_DO) return;

    // Delete oldest events (sorted ascending by key = oldest first)
    const toDelete = all.size - MAX_EVENTS_IN_DO;
    const keys: string[] = [];
    let count = 0;
    for (const [key] of all) {
      if (count >= toDelete) break;
      keys.push(key);
      count++;
    }

    if (keys.length > 0) {
      await this.ctx.storage.delete(keys);
    }
  }

  // -------------------------------------------------------------------------
  // Scan state (generic get/put)
  // -------------------------------------------------------------------------

  private async handleGetScanState<T>(
    key: string,
    defaultValue: T
  ): Promise<Response> {
    const state = await this.ctx.storage.get<T>(key);
    return Response.json({
      ok: true,
      data: state ?? defaultValue,
    } satisfies DOResult<T>);
  }

  private async handlePutScanState<T>(
    key: string,
    request: Request
  ): Promise<Response> {
    const state = (await request.json()) as T;
    await this.ctx.storage.put(key, state);
    return Response.json({ ok: true, data: state } satisfies DOResult<T>);
  }

  private async handleGetGitHubMap(): Promise<Response> {
    const state = await this.ctx.storage.get<GitHubMapState>(
      STORAGE_KEYS.githubMap
    );
    const result: GitHubMapState = state ?? {
      mapping: { ...SEED_GITHUB_MAPPINGS },
    };
    return Response.json({
      ok: true,
      data: result,
    } satisfies DOResult<GitHubMapState>);
  }

  // -------------------------------------------------------------------------
  // Alarm management
  // -------------------------------------------------------------------------

  private async handleStartAlarms(): Promise<Response> {
    const existingAlarm = await this.ctx.storage.getAlarm();
    if (existingAlarm) {
      return Response.json({
        ok: true,
        data: {
          alreadyScheduled: true,
          nextAt: new Date(existingAlarm).toISOString(),
        },
      });
    }

    // Schedule first alarm for 1 minute from now
    await this.ctx.storage.setAlarm(Date.now() + 60_000);

    // Initialize alarm meta
    const meta = await this.getAlarmMeta();
    if (!meta.lastTask) {
      await this.ctx.storage.put(STORAGE_KEYS.alarmMeta, meta);
    }

    return Response.json({
      ok: true,
      data: {
        started: true,
        nextAt: new Date(Date.now() + 60_000).toISOString(),
      },
    });
  }

  private async handleAlarmStatus(): Promise<Response> {
    const meta = await this.getAlarmMeta();
    const alarm = await this.ctx.storage.getAlarm();

    return Response.json({
      ok: true,
      data: {
        ...meta,
        nextAlarmAt: alarm ? new Date(alarm).toISOString() : null,
        alarmScheduled: alarm !== null,
      },
    });
  }

  // -------------------------------------------------------------------------
  // Alarm internals
  // -------------------------------------------------------------------------

  private async getAlarmMeta(): Promise<AlarmMeta> {
    const meta = await this.ctx.storage.get<AlarmMeta>(STORAGE_KEYS.alarmMeta);
    return meta ?? { lastTask: null, lastRunAt: null, taskHistory: [] };
  }

  private getNextAlarmTask(lastTask: AlarmTask | null): AlarmTask {
    if (!lastTask) return ALARM_CHAIN[0]!;
    const idx = ALARM_CHAIN.indexOf(lastTask);
    return ALARM_CHAIN[(idx + 1) % ALARM_CHAIN.length]!;
  }

  /**
   * Run a single alarm task. Each task reads/writes its own scan state
   * and project data through DO storage. The DO's single-threaded model
   * guarantees no concurrent execution.
   *
   * Task implementations are stubs that log intent — the actual background
   * task logic (GitHub fetching, mention scanning, etc.) will be ported from
   * v1's _tasks.js in subsequent PRs. The alarm chain itself is fully
   * functional: it cycles through tasks, respects intervals, and persists state.
   */
  private async runAlarmTask(task: AlarmTask): Promise<void> {
    switch (task) {
      case "github-refresh": {
        console.log("[alarm:github-refresh] Checking for stale GitHub data");
        const order =
          (await this.ctx.storage.get<string[]>(STORAGE_KEYS.projectOrder)) ??
          [];
        const now = Date.now();
        const staleMs = 15 * 60 * 1000;
        let refreshed = 0;

        for (const id of order) {
          const item = await this.ctx.storage.get<ProjectItem>(
            STORAGE_KEYS.projectPrefix + id
          );
          if (!item?.githubData?.fetchedAt) continue;
          const age = now - new Date(item.githubData.fetchedAt).getTime();
          if (age > staleMs) refreshed++;
        }
        console.log(
          `[alarm:github-refresh] ${refreshed}/${order.length} items have stale GitHub data`
        );
        break;
      }

      case "mention-scan": {
        console.log("[alarm:mention-scan] Checking for new mentions");
        const state = await this.ctx.storage.get<MentionScanState>(
          STORAGE_KEYS.mentionScan
        );
        console.log(
          `[alarm:mention-scan] Last scan: ${state?.lastScanAt ?? "never"}, processed: ${state?.processedIds?.length ?? 0}`
        );
        break;
      }

      case "contributor-scan": {
        console.log("[alarm:contributor-scan] Scanning GitHub contributors");
        const scanState = await this.ctx.storage.get<GitHubScanState>(
          STORAGE_KEYS.githubScan
        );
        const repoCount = scanState
          ? Object.keys(scanState.repos).length
          : 0;
        console.log(
          `[alarm:contributor-scan] Tracking ${repoCount} repos`
        );
        break;
      }

      case "pr-scan": {
        console.log("[alarm:pr-scan] Scanning for merged PRs");
        const scanState = await this.ctx.storage.get<GitHubScanState>(
          STORAGE_KEYS.githubScan
        );
        const repoCount = scanState
          ? Object.keys(scanState.repos).length
          : 0;
        console.log(`[alarm:pr-scan] Tracking ${repoCount} repos`);
        break;
      }

      case "website-discovery": {
        console.log("[alarm:website-discovery] Discovering project websites");
        const order =
          (await this.ctx.storage.get<string[]>(STORAGE_KEYS.projectOrder)) ??
          [];
        let withoutSite = 0;
        for (const id of order) {
          const item = await this.ctx.storage.get<ProjectItem>(
            STORAGE_KEYS.projectPrefix + id
          );
          if (item && !item.website) withoutSite++;
        }
        console.log(
          `[alarm:website-discovery] ${withoutSite}/${order.length} items missing websites`
        );
        break;
      }
    }
  }
}

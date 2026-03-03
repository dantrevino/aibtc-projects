import type { Env, RoadmapData, AgentRef, ProjectItem } from "../lib/types";
import { KV_KEY } from "../lib/constants";

/** Read roadmap data from KV with lazy migrations */
export async function getData(env: Env): Promise<RoadmapData> {
  const raw = await env.ROADMAP_KV.get<RoadmapData>(KV_KEY, "json");
  const data: RoadmapData = raw ?? { version: 1, writeVersion: 0, items: [] };

  if (typeof data.writeVersion !== "number") data.writeVersion = 0;

  // TODO: port v1→v10 lazy migrations from _tasks.js

  return data;
}

/** Save roadmap data to KV with optimistic concurrency */
export async function saveData(env: Env, data: RoadmapData): Promise<void> {
  const expectedVersion = data.writeVersion ?? 0;
  const current = await env.ROADMAP_KV.get<RoadmapData>(KV_KEY, "json");
  const currentVersion = current?.writeVersion ?? 0;

  if (currentVersion !== expectedVersion) {
    throw new ConcurrencyError();
  }

  data.writeVersion = expectedVersion + 1;
  data.updatedAt = new Date().toISOString();
  await env.ROADMAP_KV.put(KV_KEY, JSON.stringify(data));
}

/** Best-effort save: retry once on conflict */
export async function saveRetry(env: Env, data: RoadmapData): Promise<void> {
  try {
    await saveData(env, data);
  } catch (err) {
    if (!(err instanceof ConcurrencyError)) throw err;
    console.error("[saveRetry] conflict, retrying with fresh version");
    const fresh = await env.ROADMAP_KV.get<RoadmapData>(KV_KEY, "json");
    data.writeVersion = fresh?.writeVersion ?? 0;
    await saveData(env, data);
  }
}

/** Add agent to contributors list if not already present */
export function addContributor(item: ProjectItem, agent: AgentRef): void {
  if (!agent?.btcAddress) return;
  if (!item.contributors) item.contributors = [];
  const exists = item.contributors.some(
    (c) => c.btcAddress === agent.btcAddress
  );
  if (!exists) {
    item.contributors.push({
      btcAddress: agent.btcAddress,
      displayName: agent.displayName,
      agentId: agent.agentId ?? null,
    });
  }
}

export class ConcurrencyError extends Error {
  constructor() {
    super("Concurrent write detected");
    this.name = "ConcurrencyError";
  }
}

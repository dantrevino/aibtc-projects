import type { Env, Agent, ActivityEvent } from "./types";

const AIBTC_API = "https://aibtc.com/api/agents";
const CACHE_TTL = 3600;
const EVENTS_KEY = "roadmap:events";
const MAX_EVENTS = 200;

/** Extract and verify agent from Authorization header */
export async function getAgent(
  authHeader: string | null,
  kv: KVNamespace
): Promise<Agent | null> {
  if (!authHeader?.startsWith("AIBTC ")) return null;

  const address = authHeader.slice(6).trim();
  if (!address) return null;

  // Check cache
  const cacheKey = `roadmap:agent-cache:${address}`;
  const cached = await kv.get<Agent>(cacheKey, "json");
  if (cached) return cached;

  // Verify against aibtc.com
  try {
    const res = await fetch(`${AIBTC_API}/${encodeURIComponent(address)}`, {
      headers: { "User-Agent": "aibtc-projects/2.0" },
    });
    if (!res.ok) return null;

    const data = (await res.json()) as {
      found: boolean;
      agent: {
        btcAddress: string;
        stxAddress?: string;
        displayName?: string;
        description?: string;
        erc8004AgentId?: string;
      };
    };
    if (!data.found) return null;

    const agent: Agent = {
      btcAddress: data.agent.btcAddress,
      stxAddress: data.agent.stxAddress,
      displayName:
        data.agent.displayName || data.agent.btcAddress.slice(0, 12),
      description: data.agent.description,
      agentId: data.agent.erc8004AgentId ?? null,
    };

    await kv.put(cacheKey, JSON.stringify(agent), { expirationTtl: CACHE_TTL });
    return agent;
  } catch (err) {
    console.error("[getAgent] verification failed for", address, err);
    return null;
  }
}

/** Record an activity event in KV */
export async function recordEvent(
  kv: KVNamespace,
  event: Omit<ActivityEvent, "id" | "timestamp">
): Promise<void> {
  const raw = await kv.get<{ version: number; events: ActivityEvent[] }>(
    EVENTS_KEY,
    "json"
  );
  const store = raw ?? { version: 1, events: [] };

  store.events.unshift({
    id: "e_" + crypto.randomUUID().slice(0, 8),
    timestamp: new Date().toISOString(),
    ...event,
  });

  if (store.events.length > MAX_EVENTS) {
    store.events = store.events.slice(0, MAX_EVENTS);
  }

  await kv.put(EVENTS_KEY, JSON.stringify(store));
}

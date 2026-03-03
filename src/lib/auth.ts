import { createMiddleware } from "hono/factory";
import type { Env, Agent, AuthVariables } from "./types";
import { getAgentCache, putAgentCache } from "./do-client";

const AIBTC_API = "https://aibtc.com/api/agents";

/** Response shape from the aibtc.com agent verification API */
interface AgentVerifyResponse {
  found: boolean;
  agent: {
    btcAddress: string;
    stxAddress?: string;
    displayName?: string;
    description?: string;
    erc8004AgentId?: string;
  };
}

/**
 * Verify an agent address against the aibtc.com API.
 * Returns the Agent object on success, null if not found or on error.
 */
async function verifyAgent(address: string): Promise<Agent | null> {
  try {
    const res = await fetch(
      `${AIBTC_API}/${encodeURIComponent(address)}`,
      { headers: { "User-Agent": "aibtc-projects/2.0" } }
    );
    if (!res.ok) return null;

    const data = (await res.json()) as AgentVerifyResponse;
    if (!data.found) return null;

    return {
      btcAddress: data.agent.btcAddress,
      stxAddress: data.agent.stxAddress,
      displayName:
        data.agent.displayName || data.agent.btcAddress.slice(0, 12),
      description: data.agent.description,
      agentId: data.agent.erc8004AgentId ?? null,
    };
  } catch (err) {
    console.error("[auth] verification failed for", address, err);
    return null;
  }
}

/**
 * Parse the AIBTC auth header and resolve the agent (with DO cache).
 * Returns the Agent if valid, null otherwise.
 */
async function resolveAgent(
  authHeader: string | null,
  env: Env
): Promise<Agent | null> {
  if (!authHeader?.startsWith("AIBTC ")) return null;

  const address = authHeader.slice(6).trim();
  if (!address) return null;

  // Check DO cache
  const cached = await getAgentCache(env, address);
  if (cached) return cached;

  // Verify against aibtc.com
  const agent = await verifyAgent(address);
  if (!agent) return null;

  // Cache in DO (fire-and-forget — don't block response on cache write)
  putAgentCache(env, address, agent).catch((err) => {
    console.error("[auth] cache write failed for", address, err);
  });

  return agent;
}

/**
 * Auth middleware — extracts and resolves the agent from the Authorization
 * header, then attaches it to context. Does not block unauthenticated
 * requests; use `requireAuth` for that.
 *
 * Header format: Authorization: AIBTC {btcAddress}
 * Agent data is cached in Durable Object storage (1hr TTL).
 */
export const authMiddleware = createMiddleware<{
  Bindings: Env;
  Variables: AuthVariables;
}>(async (c, next) => {
  const agent = await resolveAgent(
    c.req.header("Authorization") ?? null,
    c.env
  );
  c.set("agent", agent);
  await next();
});

/**
 * Guard middleware — returns 401 if no auth header was provided, or 403 if
 * the header was present but the agent could not be verified.
 * Must be applied after `authMiddleware`.
 */
export const requireAuth = createMiddleware<{
  Bindings: Env;
  Variables: AuthVariables;
}>(async (c, next) => {
  const agent = c.get("agent");
  if (agent) {
    await next();
    return;
  }

  const header = c.req.header("Authorization");
  if (!header) {
    return c.json(
      { error: "Not authenticated. Use header: Authorization: AIBTC {btcAddress}" },
      401
    );
  }

  // Header was provided but agent could not be verified
  return c.json(
    { error: "Agent not registered or verification failed" },
    403
  );
});

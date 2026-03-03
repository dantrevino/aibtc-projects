import { Hono } from "hono";
import type { Env } from "../lib/types";
import { TIME_BUDGET_MS } from "../lib/constants";

export const refresh = new Hono<{ Bindings: Env }>();

// GET /api/refresh — trigger background data refresh (key-gated)
refresh.get("/", async (c) => {
  const url = new URL(c.req.url);
  const secret = url.searchParams.get("key");

  if (c.env.REFRESH_KEY && secret !== c.env.REFRESH_KEY) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const start = Date.now();
  const _deadline = start + TIME_BUDGET_MS;
  const _reset = url.searchParams.get("reset") === "true";

  // TODO: port background task orchestration
  // - refreshStaleGithubData
  // - scanForMentions
  // - scanGithubContributors
  // - scanGithubEvents
  // - discoverWebsites
  // - backfillMentions

  const elapsed = Date.now() - start;

  return c.json({
    ok: true,
    elapsed: `${elapsed}ms`,
    message: "v2 scaffold — background tasks not yet ported",
    timestamp: new Date().toISOString(),
  });
});

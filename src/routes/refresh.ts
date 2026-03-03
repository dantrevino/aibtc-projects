import { Hono } from "hono";
import type { Env } from "../lib/types";
import { startAlarms, getAlarmStatus } from "../lib/do-client";
import { ensureMigrated } from "../lib/do-client";

export const refresh = new Hono<{ Bindings: Env }>();

// POST /api/refresh — trigger background task alarms (key-gated)
//
// v2 replaces the GitHub Actions cron with DO alarm chains.
// Secured by REFRESH_KEY — called by alarm, not cron.
// This endpoint:
//   - Ensures KV→DO migration has run
//   - Starts the alarm chain if not already running
//   - Returns alarm status
refresh.post("/", async (c) => {
  const body = await c.req.json<{ key?: string }>().catch((): { key?: string } => ({}));
  const url = new URL(c.req.url);
  const secret = body.key ?? url.searchParams.get("key");

  if (c.env.REFRESH_KEY && secret !== c.env.REFRESH_KEY) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const start = Date.now();

  // Ensure migration first
  await ensureMigrated(c.env);

  // Start alarm chain (idempotent — skips if already running)
  await startAlarms(c.env);

  // Return current alarm status
  const status = await getAlarmStatus(c.env);

  const elapsed = Date.now() - start;

  return c.json({
    ok: true,
    elapsed: `${elapsed}ms`,
    alarms: status,
    timestamp: new Date().toISOString(),
  });
});

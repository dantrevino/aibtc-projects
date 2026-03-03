import { Hono } from "hono";
import type { Env } from "../lib/types";
import { getAgent } from "../lib/auth";
import { reorderProjects, recordEvent } from "../lib/do-client";

export const reorder = new Hono<{ Bindings: Env }>();

// POST /api/reorder — reorder items (auth required)
reorder.post("/", async (c) => {
  const agent = await getAgent(
    c.req.header("Authorization") ?? null,
    c.env.ROADMAP_KV
  );
  if (!agent) {
    return c.json(
      { error: "Not authenticated. Use header: Authorization: AIBTC {btcAddress}" },
      401
    );
  }

  const body = await c.req.json<{ order?: string[] }>();
  if (!Array.isArray(body.order)) {
    return c.json({ error: "order must be a string array" }, 400);
  }

  const result = await reorderProjects(c.env, body.order);
  if (!result.ok) {
    return c.json({ error: result.error }, 400);
  }

  await recordEvent(c.env, {
    type: "items.reordered",
    agent: {
      btcAddress: agent.btcAddress,
      displayName: agent.displayName,
      agentId: agent.agentId ?? null,
    },
    itemId: null,
    itemTitle: null,
    data: { count: body.order.length },
  });

  return c.json({ ok: true, order: result.data });
});

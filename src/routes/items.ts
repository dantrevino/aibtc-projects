import { Hono } from "hono";
import type { Env } from "../lib/types";
import { getAgent, recordEvent } from "../lib/auth";

export const items = new Hono<{ Bindings: Env }>();

// GET /api/items — list all projects (public)
items.get("/", async (c) => {
  // TODO: port getData + deriveStatus + background refresh
  return c.json({ items: [], message: "v2 scaffold — not yet implemented" });
});

// POST /api/items — create a project (auth required)
items.post("/", async (c) => {
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

  // TODO: port item creation logic
  return c.json({ message: "v2 scaffold — not yet implemented" }, 501);
});

// PUT /api/items — update/claim/rate/goal (auth required)
items.put("/", async (c) => {
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

  // TODO: port update actions (claim, unclaim, rate, goal, deliverable, etc.)
  return c.json({ message: "v2 scaffold — not yet implemented" }, 501);
});

// DELETE /api/items — remove a project (auth required)
items.delete("/", async (c) => {
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

  // TODO: port delete logic
  return c.json({ message: "v2 scaffold — not yet implemented" }, 501);
});

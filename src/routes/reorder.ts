import { Hono } from "hono";
import type { Env } from "../lib/types";
import { getAgent, recordEvent } from "../lib/auth";

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

  // TODO: port reorder logic
  return c.json({ message: "v2 scaffold — not yet implemented" }, 501);
});

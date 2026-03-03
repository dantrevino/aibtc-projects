import { Hono } from "hono";
import type { Env } from "../lib/types";

export const mentions = new Hono<{ Bindings: Env }>();

// GET /api/mentions?itemId=... — mention details for a project
mentions.get("/", async (c) => {
  const itemId = c.req.query("itemId");
  if (!itemId) {
    return c.json({ error: "itemId is required" }, 400);
  }

  // TODO: port mention scanning from message archive + live activity
  return c.json({ itemId, message: "v2 scaffold — not yet implemented" }, 501);
});

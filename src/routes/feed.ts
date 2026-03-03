import { Hono } from "hono";
import type { Env } from "../lib/types";
import { listEvents } from "../lib/do-client";

export const feed = new Hono<{ Bindings: Env }>();

// GET /api/feed — public activity feed (now backed by DO storage)
feed.get("/", async (c) => {
  const url = new URL(c.req.url);
  const limit = Math.min(
    parseInt(url.searchParams.get("limit") ?? "50", 10),
    200
  );
  const typeFilter = url.searchParams.get("type") ?? undefined;
  const itemIdFilter = url.searchParams.get("itemId") ?? undefined;
  const cursor = url.searchParams.get("cursor") ?? undefined;

  const result = await listEvents(c.env, {
    limit,
    type: typeFilter,
    itemId: itemIdFilter,
    cursor,
  });

  return c.json({
    events: result.events,
    total: result.total,
    cursor: result.cursor,
  });
});

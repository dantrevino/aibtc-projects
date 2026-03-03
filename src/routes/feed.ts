import { Hono } from "hono";
import type { Env, ActivityEvent } from "../lib/types";
import { EVENTS_KEY } from "../lib/constants";

export const feed = new Hono<{ Bindings: Env }>();

// GET /api/feed — public activity feed
feed.get("/", async (c) => {
  const url = new URL(c.req.url);
  const limit = Math.min(
    parseInt(url.searchParams.get("limit") ?? "50", 10),
    200
  );
  const typeFilter = url.searchParams.get("type");
  const itemIdFilter = url.searchParams.get("itemId");

  const raw = await c.env.ROADMAP_KV.get<{
    version: number;
    events: ActivityEvent[];
  }>(EVENTS_KEY, "json");
  const store = raw ?? { version: 1, events: [] };

  let events = store.events;
  if (typeFilter) events = events.filter((e) => e.type === typeFilter);
  if (itemIdFilter) events = events.filter((e) => e.itemId === itemIdFilter);
  events = events.slice(0, limit);

  return c.json({ events, total: events.length });
});

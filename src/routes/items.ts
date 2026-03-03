import { Hono } from "hono";
import type { Env, ProjectItem } from "../lib/types";
import { getAgent } from "../lib/auth";
import { recordEvent } from "../lib/do-client";
import { getData, saveProject, addProject, removeProject } from "../tasks/data";
import { deriveStatus } from "../tasks/github";

export const items = new Hono<{ Bindings: Env }>();

// GET /api/items — list all projects (public)
items.get("/", async (c) => {
  const projects = await getData(c.env);

  // Derive status from GitHub data for each item
  const withStatus = projects.map((item) => ({
    ...item,
    status: deriveStatus(item),
  }));

  return c.json({ items: withStatus });
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

  const body = await c.req.json<{
    title?: string;
    description?: string;
    githubUrl?: string;
  }>();

  if (!body.title || !body.githubUrl) {
    return c.json({ error: "title and githubUrl are required" }, 400);
  }

  const now = new Date().toISOString();
  const item: ProjectItem = {
    id: "r_" + crypto.randomUUID().slice(0, 8),
    title: body.title,
    description: body.description ?? "",
    githubUrl: body.githubUrl,
    githubData: null,
    founder: {
      btcAddress: agent.btcAddress,
      displayName: agent.displayName,
      agentId: agent.agentId ?? null,
    },
    contributors: [
      {
        btcAddress: agent.btcAddress,
        displayName: agent.displayName,
        agentId: agent.agentId ?? null,
      },
    ],
    leader: null,
    status: "todo",
    claimedBy: null,
    deliverables: [],
    ratings: [],
    reputation: { average: 0, count: 0 },
    goals: [],
    mentions: { count: 0 },
    website: null,
    createdAt: now,
    updatedAt: now,
  };

  const created = await addProject(c.env, item);
  if (!created) {
    return c.json({ error: "Failed to create project" }, 500);
  }

  await recordEvent(c.env, {
    type: "item.created",
    agent: {
      btcAddress: agent.btcAddress,
      displayName: agent.displayName,
      agentId: agent.agentId ?? null,
    },
    itemId: item.id,
    itemTitle: item.title,
    data: { githubUrl: item.githubUrl },
  });

  return c.json({ item: created }, 201);
});

// PUT /api/items — update a project (auth required)
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

  const body = await c.req.json<{
    id?: string;
    title?: string;
    description?: string;
    githubUrl?: string;
  }>();

  if (!body.id) {
    return c.json({ error: "id is required" }, 400);
  }

  const updates: Partial<ProjectItem> = {};
  if (body.title !== undefined) updates.title = body.title;
  if (body.description !== undefined) updates.description = body.description;
  if (body.githubUrl !== undefined) updates.githubUrl = body.githubUrl;

  const updated = await saveProject(c.env, body.id, updates);
  if (!updated) {
    return c.json({ error: "Project not found" }, 404);
  }

  await recordEvent(c.env, {
    type: "item.updated",
    agent: {
      btcAddress: agent.btcAddress,
      displayName: agent.displayName,
      agentId: agent.agentId ?? null,
    },
    itemId: updated.id,
    itemTitle: updated.title,
    data: { fields: Object.keys(updates) },
  });

  return c.json({ item: updated });
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

  const body = await c.req.json<{ id?: string }>();
  if (!body.id) {
    return c.json({ error: "id is required" }, 400);
  }

  const deleted = await removeProject(c.env, body.id);
  if (!deleted) {
    return c.json({ error: "Project not found" }, 404);
  }

  await recordEvent(c.env, {
    type: "item.deleted",
    agent: {
      btcAddress: agent.btcAddress,
      displayName: agent.displayName,
      agentId: agent.agentId ?? null,
    },
    itemId: deleted.id,
    itemTitle: deleted.title,
    data: {},
  });

  return c.json({ item: deleted });
});

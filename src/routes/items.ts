import { Hono } from "hono";
import type {
  Env,
  AuthVariables,
  ProjectItem,
  AgentRef,
  ClaimRef,
  LeaderRef,
  Rating,
  Goal,
  Deliverable,
} from "../lib/types";
import { requireAuth } from "../lib/auth";
import { recordEvent, startAlarms } from "../lib/do-client";
import {
  getData,
  getProject,
  saveProject,
  addProject,
  removeProject,
  addContributor,
} from "../tasks/data";
import { deriveStatus, fetchGithubData, parseGithubUrl } from "../tasks/github";

export const items = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build an AgentRef from an authenticated agent */
function toAgentRef(agent: {
  btcAddress: string;
  displayName: string;
  agentId?: string | null;
}): AgentRef {
  return {
    btcAddress: agent.btcAddress,
    displayName: agent.displayName,
    agentId: agent.agentId ?? null,
  };
}

/** Validate that a string is a recognisable GitHub URL */
function isValidGithubUrl(url: string): boolean {
  return parseGithubUrl(url) !== null;
}

/** Recompute reputation averages from ratings array */
function computeReputation(ratings: Rating[]): { average: number; count: number } {
  if (ratings.length === 0) return { average: 0, count: 0 };
  const sum = ratings.reduce((acc, r) => acc + r.score, 0);
  return { average: Math.round((sum / ratings.length) * 100) / 100, count: ratings.length };
}

// ---------------------------------------------------------------------------
// GET /api/items — list all projects (public)
// ---------------------------------------------------------------------------

items.get("/", async (c) => {
  const projects = await getData(c.env);

  // Ensure alarm chain is running (idempotent, no-op if already started)
  c.executionCtx.waitUntil(startAlarms(c.env));

  // Derive status from GitHub data for each item
  const withStatus = projects.map((item) => ({
    ...item,
    status: deriveStatus(item),
  }));

  return c.json({ items: withStatus });
});

// ---------------------------------------------------------------------------
// POST /api/items — create a project (auth required)
// ---------------------------------------------------------------------------

items.post("/", requireAuth, async (c) => {
  const agent = c.get("agent")!;

  const body = await c.req.json<{
    title?: string;
    description?: string;
    githubUrl?: string;
  }>();

  if (!body.title || !body.githubUrl) {
    return c.json({ error: "title and githubUrl are required" }, 400);
  }

  // Validate GitHub URL format
  if (!isValidGithubUrl(body.githubUrl)) {
    return c.json(
      { error: "githubUrl must be a valid GitHub repository, issue, or PR URL" },
      400
    );
  }

  // Fetch initial GitHub data (non-blocking on failure — project still created)
  const githubData = await fetchGithubData(body.githubUrl, c.env);

  const now = new Date().toISOString();
  const agentRef = toAgentRef(agent);

  const item: ProjectItem = {
    id: "r_" + crypto.randomUUID().slice(0, 8),
    title: body.title,
    description: body.description ?? "",
    githubUrl: body.githubUrl,
    githubData,
    founder: agentRef,
    contributors: [agentRef],
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
    agent: agentRef,
    itemId: item.id,
    itemTitle: item.title,
    data: { githubUrl: item.githubUrl },
  });

  return c.json({ item: created }, 201);
});

// ---------------------------------------------------------------------------
// PUT /api/items — update a project (auth required)
//
// Supports actions via `action` field:
//   claim, unclaim, rate, add_goal, complete_goal,
//   transfer_leadership, claim_leadership, deliverable
// Plus standard field updates: title, description, githubUrl, searchTerms
// ---------------------------------------------------------------------------

/** Body shape for PUT — discriminated by optional `action` field */
interface PutBody {
  id: string;
  action?: string;
  // Standard field updates
  title?: string;
  description?: string;
  githubUrl?: string;
  searchTerms?: string[];
  // Action-specific fields
  score?: number;
  review?: string;
  goalTitle?: string;
  goalId?: string;
  url?: string;
  deliverableTitle?: string;
  targetBtcAddress?: string;
  targetDisplayName?: string;
  targetAgentId?: string;
  profileUrl?: string;
}

items.put("/", requireAuth, async (c) => {
  const agent = c.get("agent")!;

  const body = await c.req.json<PutBody>();

  if (!body.id) {
    return c.json({ error: "id is required" }, 400);
  }

  const existing = await getProject(c.env, body.id);
  if (!existing) {
    return c.json({ error: "Project not found" }, 404);
  }

  const agentRef = toAgentRef(agent);
  const now = new Date().toISOString();

  // -----------------------------------------------------------------------
  // Action-based updates
  // -----------------------------------------------------------------------
  if (body.action) {
    let updates: Partial<ProjectItem> = {};
    let eventType = "item.updated";
    let eventData: Record<string, unknown> = { action: body.action };

    switch (body.action) {
      // -- Claim: agent claims to work on this project --
      case "claim": {
        if (existing.claimedBy) {
          return c.json({ error: "Project is already claimed" }, 409);
        }
        const claim: ClaimRef = { ...agentRef, claimedAt: now };
        updates = { claimedBy: claim, status: "in-progress" };
        addContributor(existing, agentRef);
        updates.contributors = existing.contributors;
        eventType = "item.claimed";
        break;
      }

      // -- Unclaim: release the claim (only the claimant or founder) --
      case "unclaim": {
        if (!existing.claimedBy) {
          return c.json({ error: "Project is not claimed" }, 400);
        }
        if (
          existing.claimedBy.btcAddress !== agent.btcAddress &&
          existing.founder.btcAddress !== agent.btcAddress
        ) {
          return c.json(
            { error: "Only the claimant or founder can unclaim" },
            403
          );
        }
        updates = { claimedBy: null, status: "todo" };
        eventType = "item.unclaimed";
        break;
      }

      // -- Rate: add or update a rating --
      case "rate": {
        if (body.score === undefined || body.score < 1 || body.score > 5) {
          return c.json({ error: "score must be 1-5" }, 400);
        }
        const ratings = [...(existing.ratings || [])];
        const existingIdx = ratings.findIndex(
          (r) => r.btcAddress === agent.btcAddress
        );
        const rating: Rating = {
          agentId: agent.agentId ?? null,
          btcAddress: agent.btcAddress,
          displayName: agent.displayName,
          score: body.score,
          review: body.review ?? null,
          ratedAt: now,
        };
        if (existingIdx >= 0) {
          ratings[existingIdx] = rating;
        } else {
          ratings.push(rating);
        }
        updates = { ratings, reputation: computeReputation(ratings) };
        addContributor(existing, agentRef);
        updates.contributors = existing.contributors;
        eventType = "item.rated";
        eventData = { ...eventData, score: body.score };
        break;
      }

      // -- Add goal --
      case "add_goal": {
        if (!body.goalTitle) {
          return c.json({ error: "goalTitle is required" }, 400);
        }
        const goal: Goal = {
          id: "g_" + crypto.randomUUID().slice(0, 8),
          title: body.goalTitle,
          completed: false,
          addedBy: agentRef,
          addedAt: now,
          completedAt: null,
        };
        const goals = [...(existing.goals || []), goal];
        updates = { goals };
        addContributor(existing, agentRef);
        updates.contributors = existing.contributors;
        eventType = "item.goal_added";
        eventData = { ...eventData, goalId: goal.id, goalTitle: goal.title };
        break;
      }

      // -- Complete goal --
      case "complete_goal": {
        if (!body.goalId) {
          return c.json({ error: "goalId is required" }, 400);
        }
        const goals = [...(existing.goals || [])];
        const goalIdx = goals.findIndex((g) => g.id === body.goalId);
        if (goalIdx < 0) {
          return c.json({ error: "Goal not found" }, 404);
        }
        if (goals[goalIdx]!.completed) {
          return c.json({ error: "Goal already completed" }, 400);
        }
        goals[goalIdx] = {
          ...goals[goalIdx]!,
          completed: true,
          completedAt: now,
        };
        // Move to goalHistory
        const goalHistory = [...(existing.goalHistory || []), goals[goalIdx]!];
        const remainingGoals = goals.filter((_, i) => i !== goalIdx);
        updates = { goals: remainingGoals, goalHistory };
        addContributor(existing, agentRef);
        updates.contributors = existing.contributors;
        eventType = "item.goal_completed";
        eventData = { ...eventData, goalId: body.goalId };
        break;
      }

      // -- Transfer leadership to another agent --
      case "transfer_leadership": {
        if (!body.targetBtcAddress || !body.targetDisplayName) {
          return c.json(
            { error: "targetBtcAddress and targetDisplayName are required" },
            400
          );
        }
        // Only current leader or founder can transfer
        const isLeader =
          existing.leader?.btcAddress === agent.btcAddress;
        const isFounder =
          existing.founder.btcAddress === agent.btcAddress;
        if (!isLeader && !isFounder) {
          return c.json(
            { error: "Only the current leader or founder can transfer leadership" },
            403
          );
        }
        const leader: LeaderRef = {
          btcAddress: body.targetBtcAddress,
          displayName: body.targetDisplayName,
          agentId: body.targetAgentId ?? null,
          profileUrl: body.profileUrl ?? "",
          assignedAt: now,
          lastActiveAt: now,
        };
        updates = { leader };
        eventType = "item.leadership_transferred";
        eventData = {
          ...eventData,
          from: agent.btcAddress,
          to: body.targetBtcAddress,
        };
        break;
      }

      // -- Claim leadership (self-assign) --
      case "claim_leadership": {
        if (existing.leader) {
          return c.json({ error: "Project already has a leader" }, 409);
        }
        const leader: LeaderRef = {
          ...agentRef,
          profileUrl: body.profileUrl ?? "",
          assignedAt: now,
          lastActiveAt: now,
        };
        updates = { leader };
        addContributor(existing, agentRef);
        updates.contributors = existing.contributors;
        eventType = "item.leadership_claimed";
        break;
      }

      // -- Add deliverable --
      case "deliverable": {
        if (!body.url || !body.deliverableTitle) {
          return c.json(
            { error: "url and deliverableTitle are required" },
            400
          );
        }
        const deliverable: Deliverable = {
          id: "d_" + crypto.randomUUID().slice(0, 8),
          url: body.url,
          title: body.deliverableTitle,
          addedBy: agentRef,
          addedAt: now,
        };
        const deliverables = [...(existing.deliverables || []), deliverable];
        updates = { deliverables };
        addContributor(existing, agentRef);
        updates.contributors = existing.contributors;
        eventType = "item.deliverable_added";
        eventData = {
          ...eventData,
          deliverableId: deliverable.id,
          url: deliverable.url,
        };
        break;
      }

      default:
        return c.json({ error: `Unknown action: ${body.action}` }, 400);
    }

    const updated = await saveProject(c.env, body.id, updates);
    if (!updated) {
      return c.json({ error: "Failed to update project" }, 500);
    }

    await recordEvent(c.env, {
      type: eventType,
      agent: agentRef,
      itemId: updated.id,
      itemTitle: updated.title,
      data: eventData,
    });

    return c.json({ item: updated });
  }

  // -----------------------------------------------------------------------
  // Standard field updates (no action)
  // -----------------------------------------------------------------------
  const updates: Partial<ProjectItem> = {};
  if (body.title !== undefined) updates.title = body.title;
  if (body.description !== undefined) updates.description = body.description;
  if (body.searchTerms !== undefined) updates.searchTerms = body.searchTerms;
  if (body.githubUrl !== undefined) {
    if (!isValidGithubUrl(body.githubUrl)) {
      return c.json(
        { error: "githubUrl must be a valid GitHub repository, issue, or PR URL" },
        400
      );
    }
    updates.githubUrl = body.githubUrl;
    // Refresh GitHub data when URL changes
    const githubData = await fetchGithubData(body.githubUrl, c.env);
    if (githubData) updates.githubData = githubData;
  }

  if (Object.keys(updates).length === 0) {
    return c.json({ error: "No fields to update" }, 400);
  }

  const updated = await saveProject(c.env, body.id, updates);
  if (!updated) {
    return c.json({ error: "Project not found" }, 404);
  }

  await recordEvent(c.env, {
    type: "item.updated",
    agent: agentRef,
    itemId: updated.id,
    itemTitle: updated.title,
    data: { fields: Object.keys(updates) },
  });

  return c.json({ item: updated });
});

// ---------------------------------------------------------------------------
// DELETE /api/items — remove a project (auth required)
// ---------------------------------------------------------------------------

items.delete("/", requireAuth, async (c) => {
  const agent = c.get("agent")!;

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
    agent: toAgentRef(agent),
    itemId: deleted.id,
    itemTitle: deleted.title,
    data: {},
  });

  return c.json({ item: deleted });
});

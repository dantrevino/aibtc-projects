/**
 * Integration tests for the aibtc-projects API
 *
 * Uses @cloudflare/vitest-pool-workers to run tests inside the Workers runtime
 * with real Durable Object storage and KV bindings (in-memory via miniflare).
 *
 * Categories:
 * 1. Health check & routing
 * 2. Auth middleware — header parsing, 401/403 responses
 * 3. Items CRUD — create, read, update, delete
 * 4. PUT actions — claim, unclaim, rate, add_goal, complete_goal,
 *    transfer_leadership, claim_leadership, deliverable
 * 5. Feed — pagination, type/itemId filtering
 * 6. Mentions — mention drill-down
 * 7. Reorder — project reordering
 * 8. Refresh — alarm trigger
 * 9. Durable Object — direct DO operations
 */

import {
  describe,
  it,
  expect,
  beforeEach,
} from "vitest";
import { env, SELF } from "cloudflare:test";
import type { ProjectItem } from "../src/lib/types";

// ---------------------------------------------------------------------------
// Test agent (mock — bypasses external API verification via DO cache seeding)
// ---------------------------------------------------------------------------

const TEST_AGENT = {
  btcAddress: "bc1qtest_agent_address_123456789",
  displayName: "Test Agent",
  stxAddress: "SP1234567890",
  agentId: "test-agent-id",
};

const TEST_AGENT_2 = {
  btcAddress: "bc1qtest_agent_address_987654321",
  displayName: "Second Agent",
  stxAddress: "SP0987654321",
  agentId: "test-agent-2",
};

const AUTH_HEADER = `AIBTC ${TEST_AGENT.btcAddress}`;
const AUTH_HEADER_2 = `AIBTC ${TEST_AGENT_2.btcAddress}`;

/**
 * Seed the DO agent cache so auth middleware resolves without external API call.
 */
async function seedAgentCache(
  agent: typeof TEST_AGENT
): Promise<void> {
  const doId = env.PROJECTS_DO.idFromName("projects-singleton");
  const stub = env.PROJECTS_DO.get(doId);
  await stub.fetch(
    `https://do/agent-cache/${encodeURIComponent(agent.btcAddress)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(agent),
    }
  );
}

/**
 * Helper to create a project via the API, returns the created item.
 */
async function createProject(
  title: string,
  githubUrl: string,
  authHeader: string = AUTH_HEADER
): Promise<ProjectItem> {
  const res = await SELF.fetch("https://test/api/items", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: authHeader,
    },
    body: JSON.stringify({ title, githubUrl }),
  });
  const body = (await res.json()) as { item: ProjectItem };
  return body.item;
}

// =========================================================================
// 1. HEALTH CHECK & ROUTING
// =========================================================================

describe("health check", () => {
  it("GET /health returns name and version", async () => {
    const res = await SELF.fetch("https://test/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string; version: string };
    expect(body.name).toBe("aibtc-projects");
    expect(body.version).toBe("2.0.0");
  });

  it("GET /unknown returns 404", async () => {
    const res = await SELF.fetch("https://test/unknown");
    expect(res.status).toBe(404);
  });
});

// =========================================================================
// 2. AUTH MIDDLEWARE
// =========================================================================

describe("auth middleware", () => {
  it("returns 401 when no auth header on protected route", async () => {
    const res = await SELF.fetch("https://test/api/items", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Test",
        githubUrl: "https://github.com/test/repo",
      }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Not authenticated");
  });

  it("returns 403 when agent cannot be verified", async () => {
    const res = await SELF.fetch("https://test/api/items", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "AIBTC bc1qunverifiable_address",
      },
      body: JSON.stringify({
        title: "Test",
        githubUrl: "https://github.com/test/repo",
      }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("not registered");
  });

  it("allows public feed without auth", async () => {
    const res = await SELF.fetch("https://test/api/feed");
    expect(res.status).toBe(200);
  });
});

// =========================================================================
// 3. ITEMS CRUD
// =========================================================================

describe("items CRUD", () => {
  beforeEach(async () => {
    await seedAgentCache(TEST_AGENT);
    await seedAgentCache(TEST_AGENT_2);
  });

  it("POST /api/items creates a project", async () => {
    const res = await SELF.fetch("https://test/api/items", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: AUTH_HEADER,
      },
      body: JSON.stringify({
        title: "Test Project",
        description: "A test project",
        githubUrl: "https://github.com/aibtcdev/test-repo",
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { item: ProjectItem };
    expect(body.item.title).toBe("Test Project");
    expect(body.item.description).toBe("A test project");
    expect(body.item.githubUrl).toBe(
      "https://github.com/aibtcdev/test-repo"
    );
    expect(body.item.id).toMatch(/^r_/);
    expect(body.item.founder.btcAddress).toBe(TEST_AGENT.btcAddress);
    expect(body.item.contributors).toHaveLength(1);
    expect(body.item.status).toBe("todo");
  });

  it("POST /api/items rejects missing title", async () => {
    const res = await SELF.fetch("https://test/api/items", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: AUTH_HEADER,
      },
      body: JSON.stringify({
        githubUrl: "https://github.com/aibtcdev/test-repo",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/items rejects missing githubUrl", async () => {
    const res = await SELF.fetch("https://test/api/items", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: AUTH_HEADER,
      },
      body: JSON.stringify({ title: "Test" }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/items rejects invalid githubUrl", async () => {
    const res = await SELF.fetch("https://test/api/items", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: AUTH_HEADER,
      },
      body: JSON.stringify({
        title: "Test",
        githubUrl: "https://example.com/not-github",
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("valid GitHub");
  });

  it("PUT /api/items updates title and description", async () => {
    const item = await createProject(
      "Original Title",
      "https://github.com/aibtcdev/test-repo"
    );

    const res = await SELF.fetch("https://test/api/items", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: AUTH_HEADER,
      },
      body: JSON.stringify({
        id: item.id,
        title: "Updated Title",
        description: "Updated description",
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { item: ProjectItem };
    expect(body.item.title).toBe("Updated Title");
    expect(body.item.description).toBe("Updated description");
  });

  it("PUT /api/items rejects missing id", async () => {
    const res = await SELF.fetch("https://test/api/items", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: AUTH_HEADER,
      },
      body: JSON.stringify({ title: "No ID" }),
    });
    expect(res.status).toBe(400);
  });

  it("PUT /api/items returns 404 for nonexistent project", async () => {
    const res = await SELF.fetch("https://test/api/items", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: AUTH_HEADER,
      },
      body: JSON.stringify({ id: "r_nonexist", title: "X" }),
    });
    expect(res.status).toBe(404);
  });

  it("PUT /api/items rejects no fields to update", async () => {
    const item = await createProject(
      "Test",
      "https://github.com/aibtcdev/test-repo"
    );

    const res = await SELF.fetch("https://test/api/items", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: AUTH_HEADER,
      },
      body: JSON.stringify({ id: item.id }),
    });
    expect(res.status).toBe(400);
  });

  it("PUT /api/items updates searchTerms", async () => {
    const item = await createProject(
      "Test",
      "https://github.com/aibtcdev/test-repo"
    );

    const res = await SELF.fetch("https://test/api/items", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: AUTH_HEADER,
      },
      body: JSON.stringify({
        id: item.id,
        searchTerms: ["roadmap", "board"],
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { item: ProjectItem };
    expect(body.item.searchTerms).toEqual(["roadmap", "board"]);
  });

  it("DELETE /api/items removes a project", async () => {
    const item = await createProject(
      "To Delete",
      "https://github.com/aibtcdev/test-repo"
    );

    const res = await SELF.fetch("https://test/api/items", {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        Authorization: AUTH_HEADER,
      },
      body: JSON.stringify({ id: item.id }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { item: ProjectItem };
    expect(body.item.id).toBe(item.id);
  });

  it("DELETE /api/items returns 404 for nonexistent project", async () => {
    const res = await SELF.fetch("https://test/api/items", {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        Authorization: AUTH_HEADER,
      },
      body: JSON.stringify({ id: "r_nonexist" }),
    });
    expect(res.status).toBe(404);
  });

  it("DELETE /api/items rejects missing id", async () => {
    const res = await SELF.fetch("https://test/api/items", {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        Authorization: AUTH_HEADER,
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

// =========================================================================
// 4. PUT ACTIONS
// =========================================================================

describe("PUT actions", () => {
  beforeEach(async () => {
    await seedAgentCache(TEST_AGENT);
    await seedAgentCache(TEST_AGENT_2);
  });

  it("claim — sets claimedBy and status", async () => {
    const item = await createProject(
      "Claimable",
      "https://github.com/aibtcdev/test-repo"
    );

    const res = await SELF.fetch("https://test/api/items", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: AUTH_HEADER,
      },
      body: JSON.stringify({ id: item.id, action: "claim" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { item: ProjectItem };
    expect(body.item.claimedBy).not.toBeNull();
    expect(body.item.claimedBy!.btcAddress).toBe(TEST_AGENT.btcAddress);
    expect(body.item.status).toBe("in-progress");
  });

  it("claim — rejects double claim", async () => {
    const item = await createProject(
      "Already Claimed",
      "https://github.com/aibtcdev/test-repo"
    );

    await SELF.fetch("https://test/api/items", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: AUTH_HEADER,
      },
      body: JSON.stringify({ id: item.id, action: "claim" }),
    });

    const res = await SELF.fetch("https://test/api/items", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: AUTH_HEADER_2,
      },
      body: JSON.stringify({ id: item.id, action: "claim" }),
    });

    expect(res.status).toBe(409);
  });

  it("unclaim — releases claim by claimant", async () => {
    const item = await createProject(
      "Unclaim Me",
      "https://github.com/aibtcdev/test-repo"
    );

    await SELF.fetch("https://test/api/items", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: AUTH_HEADER,
      },
      body: JSON.stringify({ id: item.id, action: "claim" }),
    });

    const res = await SELF.fetch("https://test/api/items", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: AUTH_HEADER,
      },
      body: JSON.stringify({ id: item.id, action: "unclaim" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { item: ProjectItem };
    expect(body.item.claimedBy).toBeNull();
    expect(body.item.status).toBe("todo");
  });

  it("unclaim — rejects unclaim by non-claimant/non-founder", async () => {
    const item = await createProject(
      "Not Your Claim",
      "https://github.com/aibtcdev/test-repo"
    );

    await SELF.fetch("https://test/api/items", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: AUTH_HEADER,
      },
      body: JSON.stringify({ id: item.id, action: "claim" }),
    });

    const res = await SELF.fetch("https://test/api/items", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: AUTH_HEADER_2,
      },
      body: JSON.stringify({ id: item.id, action: "unclaim" }),
    });

    expect(res.status).toBe(403);
  });

  it("rate — adds rating and computes reputation", async () => {
    const item = await createProject(
      "Rate Me",
      "https://github.com/aibtcdev/test-repo"
    );

    const res = await SELF.fetch("https://test/api/items", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: AUTH_HEADER,
      },
      body: JSON.stringify({
        id: item.id,
        action: "rate",
        score: 4,
        review: "Good project",
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { item: ProjectItem };
    expect(body.item.ratings).toHaveLength(1);
    expect(body.item.ratings[0]!.score).toBe(4);
    expect(body.item.ratings[0]!.review).toBe("Good project");
    expect(body.item.reputation.average).toBe(4);
    expect(body.item.reputation.count).toBe(1);
  });

  it("rate — updates existing rating by same agent", async () => {
    const item = await createProject(
      "Re-rate Me",
      "https://github.com/aibtcdev/test-repo"
    );

    await SELF.fetch("https://test/api/items", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: AUTH_HEADER,
      },
      body: JSON.stringify({ id: item.id, action: "rate", score: 3 }),
    });

    const res = await SELF.fetch("https://test/api/items", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: AUTH_HEADER,
      },
      body: JSON.stringify({ id: item.id, action: "rate", score: 5 }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { item: ProjectItem };
    expect(body.item.ratings).toHaveLength(1);
    expect(body.item.ratings[0]!.score).toBe(5);
    expect(body.item.reputation.average).toBe(5);
  });

  it("rate — rejects score below 1", async () => {
    const item = await createProject(
      "Bad Rate",
      "https://github.com/aibtcdev/test-repo"
    );

    const res = await SELF.fetch("https://test/api/items", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: AUTH_HEADER,
      },
      body: JSON.stringify({ id: item.id, action: "rate", score: 0 }),
    });
    expect(res.status).toBe(400);
  });

  it("rate — rejects score above 5", async () => {
    const item = await createProject(
      "Bad Rate 2",
      "https://github.com/aibtcdev/test-repo"
    );

    const res = await SELF.fetch("https://test/api/items", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: AUTH_HEADER,
      },
      body: JSON.stringify({ id: item.id, action: "rate", score: 6 }),
    });
    expect(res.status).toBe(400);
  });

  it("rate — computes average across multiple agents", async () => {
    const item = await createProject(
      "Multi-rate",
      "https://github.com/aibtcdev/test-repo"
    );

    await SELF.fetch("https://test/api/items", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: AUTH_HEADER,
      },
      body: JSON.stringify({ id: item.id, action: "rate", score: 4 }),
    });

    const res = await SELF.fetch("https://test/api/items", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: AUTH_HEADER_2,
      },
      body: JSON.stringify({ id: item.id, action: "rate", score: 2 }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { item: ProjectItem };
    expect(body.item.ratings).toHaveLength(2);
    expect(body.item.reputation.average).toBe(3);
    expect(body.item.reputation.count).toBe(2);
  });

  it("add_goal — adds a goal", async () => {
    const item = await createProject(
      "Goal Project",
      "https://github.com/aibtcdev/test-repo"
    );

    const res = await SELF.fetch("https://test/api/items", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: AUTH_HEADER,
      },
      body: JSON.stringify({
        id: item.id,
        action: "add_goal",
        goalTitle: "Ship v1.0",
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { item: ProjectItem };
    expect(body.item.goals).toHaveLength(1);
    expect(body.item.goals[0]!.title).toBe("Ship v1.0");
    expect(body.item.goals[0]!.completed).toBe(false);
    expect(body.item.goals[0]!.id).toMatch(/^g_/);
  });

  it("add_goal — rejects missing goalTitle", async () => {
    const item = await createProject(
      "No Goal Title",
      "https://github.com/aibtcdev/test-repo"
    );

    const res = await SELF.fetch("https://test/api/items", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: AUTH_HEADER,
      },
      body: JSON.stringify({ id: item.id, action: "add_goal" }),
    });
    expect(res.status).toBe(400);
  });

  it("complete_goal — completes a goal and moves to history", async () => {
    const item = await createProject(
      "Complete Goal",
      "https://github.com/aibtcdev/test-repo"
    );

    const addRes = await SELF.fetch("https://test/api/items", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: AUTH_HEADER,
      },
      body: JSON.stringify({
        id: item.id,
        action: "add_goal",
        goalTitle: "Test Goal",
      }),
    });
    const addBody = (await addRes.json()) as { item: ProjectItem };
    const goalId = addBody.item.goals[0]!.id;

    const res = await SELF.fetch("https://test/api/items", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: AUTH_HEADER,
      },
      body: JSON.stringify({
        id: item.id,
        action: "complete_goal",
        goalId,
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { item: ProjectItem };
    expect(body.item.goals).toHaveLength(0);
    expect(body.item.goalHistory).toHaveLength(1);
    expect(body.item.goalHistory![0]!.completed).toBe(true);
    expect(body.item.goalHistory![0]!.completedAt).not.toBeNull();
  });

  it("claim_leadership — self-assigns leader", async () => {
    const item = await createProject(
      "Lead Me",
      "https://github.com/aibtcdev/test-repo"
    );

    const res = await SELF.fetch("https://test/api/items", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: AUTH_HEADER,
      },
      body: JSON.stringify({
        id: item.id,
        action: "claim_leadership",
        profileUrl: "https://aibtc.com/agent/test",
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { item: ProjectItem };
    expect(body.item.leader).not.toBeNull();
    expect(body.item.leader!.btcAddress).toBe(TEST_AGENT.btcAddress);
  });

  it("claim_leadership — rejects when already has leader", async () => {
    const item = await createProject(
      "Has Leader",
      "https://github.com/aibtcdev/test-repo"
    );

    await SELF.fetch("https://test/api/items", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: AUTH_HEADER,
      },
      body: JSON.stringify({ id: item.id, action: "claim_leadership" }),
    });

    const res = await SELF.fetch("https://test/api/items", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: AUTH_HEADER_2,
      },
      body: JSON.stringify({ id: item.id, action: "claim_leadership" }),
    });
    expect(res.status).toBe(409);
  });

  it("transfer_leadership — transfers from leader", async () => {
    const item = await createProject(
      "Transfer Leader",
      "https://github.com/aibtcdev/test-repo"
    );

    await SELF.fetch("https://test/api/items", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: AUTH_HEADER,
      },
      body: JSON.stringify({ id: item.id, action: "claim_leadership" }),
    });

    const res = await SELF.fetch("https://test/api/items", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: AUTH_HEADER,
      },
      body: JSON.stringify({
        id: item.id,
        action: "transfer_leadership",
        targetBtcAddress: TEST_AGENT_2.btcAddress,
        targetDisplayName: TEST_AGENT_2.displayName,
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { item: ProjectItem };
    expect(body.item.leader!.btcAddress).toBe(TEST_AGENT_2.btcAddress);
  });

  it("transfer_leadership — rejects from non-leader/non-founder", async () => {
    const item = await createProject(
      "Not Your Transfer",
      "https://github.com/aibtcdev/test-repo"
    );

    await SELF.fetch("https://test/api/items", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: AUTH_HEADER,
      },
      body: JSON.stringify({ id: item.id, action: "claim_leadership" }),
    });

    const res = await SELF.fetch("https://test/api/items", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: AUTH_HEADER_2,
      },
      body: JSON.stringify({
        id: item.id,
        action: "transfer_leadership",
        targetBtcAddress: "bc1qother",
        targetDisplayName: "Other",
      }),
    });
    expect(res.status).toBe(403);
  });

  it("deliverable — adds a deliverable", async () => {
    const item = await createProject(
      "Deliverable Project",
      "https://github.com/aibtcdev/test-repo"
    );

    const res = await SELF.fetch("https://test/api/items", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: AUTH_HEADER,
      },
      body: JSON.stringify({
        id: item.id,
        action: "deliverable",
        url: "https://github.com/aibtcdev/test-repo/pull/1",
        deliverableTitle: "Initial implementation",
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { item: ProjectItem };
    expect(body.item.deliverables).toHaveLength(1);
    expect(body.item.deliverables[0]!.url).toBe(
      "https://github.com/aibtcdev/test-repo/pull/1"
    );
    expect(body.item.deliverables[0]!.title).toBe("Initial implementation");
    expect(body.item.deliverables[0]!.id).toMatch(/^d_/);
  });

  it("deliverable — rejects missing url", async () => {
    const item = await createProject(
      "Bad Deliverable",
      "https://github.com/aibtcdev/test-repo"
    );

    const res = await SELF.fetch("https://test/api/items", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: AUTH_HEADER,
      },
      body: JSON.stringify({
        id: item.id,
        action: "deliverable",
        deliverableTitle: "Missing URL",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("deliverable — rejects missing title", async () => {
    const item = await createProject(
      "Bad Deliverable 2",
      "https://github.com/aibtcdev/test-repo"
    );

    const res = await SELF.fetch("https://test/api/items", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: AUTH_HEADER,
      },
      body: JSON.stringify({
        id: item.id,
        action: "deliverable",
        url: "https://example.com",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("unknown action — returns 400", async () => {
    const item = await createProject(
      "Unknown Action",
      "https://github.com/aibtcdev/test-repo"
    );

    const res = await SELF.fetch("https://test/api/items", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: AUTH_HEADER,
      },
      body: JSON.stringify({ id: item.id, action: "nonexistent" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Unknown action");
  });
});

// =========================================================================
// 5. FEED
// =========================================================================

describe("feed", () => {
  beforeEach(async () => {
    await seedAgentCache(TEST_AGENT);
  });

  it("GET /api/feed returns events array", async () => {
    const res = await SELF.fetch("https://test/api/feed");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      events: unknown[];
      total: number;
      cursor: string | null;
    };
    expect(body.events).toBeInstanceOf(Array);
    expect(typeof body.total).toBe("number");
  });

  it("creates events on item creation", async () => {
    await createProject(
      "Event Emitter",
      "https://github.com/aibtcdev/test-repo"
    );

    const res = await SELF.fetch("https://test/api/feed");
    const body = (await res.json()) as {
      events: Array<{ type: string }>;
    };
    const createEvents = body.events.filter(
      (e) => e.type === "item.created"
    );
    expect(createEvents.length).toBeGreaterThan(0);
  });

  it("supports type filter", async () => {
    await createProject(
      "For Feed Filter",
      "https://github.com/aibtcdev/test-repo"
    );

    const res = await SELF.fetch(
      "https://test/api/feed?type=item.created"
    );
    const body = (await res.json()) as {
      events: Array<{ type: string }>;
    };
    for (const event of body.events) {
      expect(event.type).toBe("item.created");
    }
  });

  it("supports limit parameter", async () => {
    const res = await SELF.fetch("https://test/api/feed?limit=1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      events: unknown[];
      total: number;
    };
    expect(body.events.length).toBeLessThanOrEqual(1);
  });

  it("clamps limit to 200", async () => {
    const res = await SELF.fetch("https://test/api/feed?limit=999");
    expect(res.status).toBe(200);
  });
});

// =========================================================================
// 6. MENTIONS
// =========================================================================

describe("mentions", () => {
  beforeEach(async () => {
    await seedAgentCache(TEST_AGENT);
  });

  it("GET /api/mentions requires itemId", async () => {
    const res = await SELF.fetch("https://test/api/mentions");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("itemId is required");
  });

  it("GET /api/mentions returns 404 for nonexistent project", async () => {
    const res = await SELF.fetch(
      "https://test/api/mentions?itemId=r_nonexist"
    );
    expect(res.status).toBe(404);
  });

  it("GET /api/mentions returns mention data for valid project", async () => {
    const item = await createProject(
      "Mention Target",
      "https://github.com/aibtcdev/test-repo"
    );

    const res = await SELF.fetch(
      `https://test/api/mentions?itemId=${item.id}`
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      itemId: string;
      itemTitle: string;
      mentionCount: number;
      matches: unknown[];
    };
    expect(body.itemId).toBe(item.id);
    expect(body.itemTitle).toBe("Mention Target");
    expect(body.mentionCount).toBe(0);
    expect(body.matches).toBeInstanceOf(Array);
  });
});

// =========================================================================
// 7. REORDER
// =========================================================================

describe("reorder", () => {
  beforeEach(async () => {
    await seedAgentCache(TEST_AGENT);
  });

  it("POST /api/reorder rejects non-array", async () => {
    const res = await SELF.fetch("https://test/api/reorder", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: AUTH_HEADER,
      },
      body: JSON.stringify({ order: "not-array" }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/reorder requires auth", async () => {
    const res = await SELF.fetch("https://test/api/reorder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ order: [] }),
    });
    expect(res.status).toBe(401);
  });
});

// =========================================================================
// 8. REFRESH
// =========================================================================

describe("refresh", () => {
  it("POST /api/refresh rejects wrong key", async () => {
    const res = await SELF.fetch("https://test/api/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "wrong-key" }),
    });
    expect(res.status).toBe(401);
  });

  it("POST /api/refresh accepts correct key", async () => {
    const res = await SELF.fetch("https://test/api/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "test-refresh-key" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; elapsed: string };
    expect(body.ok).toBe(true);
  });

  it("POST /api/refresh accepts key via query string", async () => {
    const res = await SELF.fetch(
      "https://test/api/refresh?key=test-refresh-key",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }
    );
    expect(res.status).toBe(200);
  });
});

// =========================================================================
// 9. DURABLE OBJECT — direct operations
// =========================================================================

describe("Durable Object", () => {
  it("health endpoint returns status", async () => {
    const doId = env.PROJECTS_DO.idFromName("projects-singleton");
    const stub = env.PROJECTS_DO.get(doId);
    const res = await stub.fetch("https://do/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      schemaVersion: number | null;
      migrated: boolean;
      projectCount: number;
    };
    expect(body.ok).toBe(true);
  });

  it("agent cache stores and retrieves agents", async () => {
    const doId = env.PROJECTS_DO.idFromName("projects-singleton");
    const stub = env.PROJECTS_DO.get(doId);
    const addr = "bc1qcachetest";

    await stub.fetch(`https://do/agent-cache/${addr}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        btcAddress: addr,
        displayName: "Cache Test",
        agentId: null,
      }),
    });

    const res = await stub.fetch(`https://do/agent-cache/${addr}`);
    const body = (await res.json()) as {
      ok: boolean;
      data: { btcAddress: string } | null;
    };
    expect(body.ok).toBe(true);
    expect(body.data).not.toBeNull();
    expect(body.data!.btcAddress).toBe(addr);
  });

  it("alarm management — start and status", async () => {
    const doId = env.PROJECTS_DO.idFromName("projects-singleton");
    const stub = env.PROJECTS_DO.get(doId);

    const startRes = await stub.fetch("https://do/alarms/start", {
      method: "POST",
    });
    expect(startRes.status).toBe(200);
    const startBody = (await startRes.json()) as {
      ok: boolean;
      data: { started?: boolean; alreadyScheduled?: boolean };
    };
    expect(startBody.ok).toBe(true);

    const statusRes = await stub.fetch("https://do/alarms/status");
    expect(statusRes.status).toBe(200);
    const statusBody = (await statusRes.json()) as {
      ok: boolean;
      data: { alarmScheduled: boolean };
    };
    expect(statusBody.ok).toBe(true);
    expect(statusBody.data.alarmScheduled).toBe(true);
  });

  it("scan state — mention scan get/put", async () => {
    const doId = env.PROJECTS_DO.idFromName("projects-singleton");
    const stub = env.PROJECTS_DO.get(doId);

    const getRes = await stub.fetch("https://do/scan/mentions");
    const getBody = (await getRes.json()) as {
      ok: boolean;
      data: { lastScanAt: string | null; processedIds: string[] };
    };
    expect(getBody.ok).toBe(true);
    expect(getBody.data.lastScanAt).toBeNull();
    expect(getBody.data.processedIds).toEqual([]);

    const state = {
      lastScanAt: "2026-03-01T00:00:00.000Z",
      processedIds: ["id1", "id2"],
    };
    await stub.fetch("https://do/scan/mentions", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(state),
    });

    const getRes2 = await stub.fetch("https://do/scan/mentions");
    const getBody2 = (await getRes2.json()) as {
      ok: boolean;
      data: typeof state;
    };
    expect(getBody2.data.lastScanAt).toBe("2026-03-01T00:00:00.000Z");
    expect(getBody2.data.processedIds).toEqual(["id1", "id2"]);
  });

  it("scan state — github map returns seed mappings", async () => {
    const doId = env.PROJECTS_DO.idFromName("projects-singleton");
    const stub = env.PROJECTS_DO.get(doId);

    const res = await stub.fetch("https://do/scan/github-map");
    const body = (await res.json()) as {
      ok: boolean;
      data: { mapping: Record<string, string> };
    };
    expect(body.ok).toBe(true);
    expect(body.data.mapping["arc0btc"]).toBe(
      "bc1qlezz2cgktx0t680ymrytef92wxksywx0jaw933"
    );
  });

  it("events — record and list", async () => {
    const doId = env.PROJECTS_DO.idFromName("projects-singleton");
    const stub = env.PROJECTS_DO.get(doId);

    const recordRes = await stub.fetch("https://do/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "test.event",
        agent: null,
        itemId: null,
        itemTitle: null,
        data: { foo: "bar" },
      }),
    });
    expect(recordRes.status).toBe(201);
    const recordBody = (await recordRes.json()) as {
      ok: boolean;
      data: { id: string; type: string };
    };
    expect(recordBody.data.id).toMatch(/^e_/);

    const listRes = await stub.fetch("https://do/events");
    const listBody = (await listRes.json()) as {
      ok: boolean;
      data: { events: Array<{ type: string }>; total: number };
    };
    expect(listBody.ok).toBe(true);
    expect(
      listBody.data.events.some((e) => e.type === "test.event")
    ).toBe(true);
  });

  it("DO returns 404 for unknown routes", async () => {
    const doId = env.PROJECTS_DO.idFromName("projects-singleton");
    const stub = env.PROJECTS_DO.get(doId);
    const res = await stub.fetch("https://do/nonexistent");
    expect(res.status).toBe(404);
  });
});

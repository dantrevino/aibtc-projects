/**
 * Comprehensive test suite for aibtc-projects
 *
 * Categories:
 * 1. Data model — parseGithubUrl, deriveStatus, addContributor
 * 2. Mention detection — getMatchTerms, matchMention
 * 3. Website discovery — isDeploymentUrl, extractUrlsFromText, extractUrlFromReadme,
 *    extractUrlFromDescription, extractUrlFromMessages
 * 4. Alarm scheduling — ALARM_CHAIN, ALARM_SCHEDULE constants
 * 5. Constants — STALE_AFTER_MS, MAX_EVENTS, SEED_GITHUB_MAPPINGS
 */

import { describe, it, expect } from "vitest";
import { parseGithubUrl, deriveStatus } from "../src/tasks/github";
import { getMatchTerms, matchMention } from "../src/tasks/mentions";
import {
  isDeploymentUrl,
  extractUrlsFromText,
  extractUrlFromReadme,
  extractUrlFromDescription,
  extractUrlFromMessages,
} from "../src/tasks/websites";
import { addContributor } from "../src/tasks/data";
import {
  ALARM_CHAIN,
  ALARM_SCHEDULE,
  STORAGE_KEYS,
} from "../src/lib/types";
import type { ProjectItem, AgentRef, GitHubData } from "../src/lib/types";
import {
  STALE_AFTER_MS,
  MAX_EVENTS,
  MAX_ARCHIVED_MESSAGES,
  SEED_GITHUB_MAPPINGS,
} from "../src/lib/constants";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeItem(overrides: Partial<ProjectItem> = {}): ProjectItem {
  return {
    id: "r_test1234",
    title: "Test Project",
    description: "A test project",
    githubUrl: "https://github.com/aibtcdev/test-project",
    githubData: null,
    founder: { btcAddress: "bc1qfounder", displayName: "Founder", agentId: null },
    contributors: [
      { btcAddress: "bc1qfounder", displayName: "Founder", agentId: null },
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
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

// =========================================================================
// 1. DATA MODEL
// =========================================================================

describe("parseGithubUrl", () => {
  it("parses a repo URL", () => {
    const result = parseGithubUrl("https://github.com/aibtcdev/skills");
    expect(result).toEqual({
      owner: "aibtcdev",
      repo: "skills",
      type: "repo",
      number: null,
    });
  });

  it("parses a repo URL with trailing slash", () => {
    const result = parseGithubUrl("https://github.com/aibtcdev/skills/");
    expect(result).toEqual({
      owner: "aibtcdev",
      repo: "skills",
      type: "repo",
      number: null,
    });
  });

  it("parses an issue URL", () => {
    const result = parseGithubUrl(
      "https://github.com/aibtcdev/skills/issues/14"
    );
    expect(result).toEqual({
      owner: "aibtcdev",
      repo: "skills",
      type: "issue",
      number: 14,
    });
  });

  it("parses a PR URL", () => {
    const result = parseGithubUrl(
      "https://github.com/aibtcdev/skills/pull/65"
    );
    expect(result).toEqual({
      owner: "aibtcdev",
      repo: "skills",
      type: "pr",
      number: 65,
    });
  });

  it("parses URLs with query strings", () => {
    const result = parseGithubUrl(
      "https://github.com/aibtcdev/skills/issues/14?tab=comments"
    );
    expect(result).toEqual({
      owner: "aibtcdev",
      repo: "skills",
      type: "issue",
      number: 14,
    });
  });

  it("parses URLs with hash fragments", () => {
    const result = parseGithubUrl(
      "https://github.com/aibtcdev/skills#readme"
    );
    expect(result).toEqual({
      owner: "aibtcdev",
      repo: "skills",
      type: "repo",
      number: null,
    });
  });

  it("returns null for non-GitHub URLs", () => {
    expect(parseGithubUrl("https://example.com")).toBeNull();
    expect(parseGithubUrl("https://gitlab.com/owner/repo")).toBeNull();
  });

  it("returns null for null and empty inputs", () => {
    expect(parseGithubUrl(null)).toBeNull();
    expect(parseGithubUrl(undefined)).toBeNull();
    expect(parseGithubUrl("")).toBeNull();
  });

  it("returns null for bare github.com URL", () => {
    expect(parseGithubUrl("https://github.com")).toBeNull();
    expect(parseGithubUrl("https://github.com/")).toBeNull();
  });

  it("handles www prefix", () => {
    const result = parseGithubUrl(
      "https://www.github.com/aibtcdev/skills"
    );
    // The regex doesn't match www. specifically, but github.com still matches
    // because the regex pattern is /github\.com\/([^/]+)\/([^/?#]+)/
    // www.github.com still contains github.com
    expect(result).not.toBeNull();
    expect(result?.repo).toBe("skills");
  });
});

describe("deriveStatus", () => {
  it("returns todo when no github data", () => {
    expect(deriveStatus({})).toBe("todo");
    expect(deriveStatus({ githubData: null })).toBe("todo");
  });

  it("returns todo when githubData has no type", () => {
    expect(deriveStatus({ githubData: {} as GitHubData })).toBe("todo");
  });

  it("returns in-progress for active repo", () => {
    expect(
      deriveStatus({
        githubData: { type: "repo", state: "active" } as GitHubData,
      })
    ).toBe("in-progress");
  });

  it("returns done for archived repo", () => {
    expect(
      deriveStatus({
        githubData: { type: "repo", state: "archived" } as GitHubData,
      })
    ).toBe("done");
  });

  it("returns done for merged PR", () => {
    expect(
      deriveStatus({
        githubData: {
          type: "pr",
          merged: true,
          state: "closed",
        } as GitHubData,
      })
    ).toBe("done");
  });

  it("returns blocked for closed unmerged PR", () => {
    expect(
      deriveStatus({
        githubData: {
          type: "pr",
          merged: false,
          state: "closed",
        } as GitHubData,
      })
    ).toBe("blocked");
  });

  it("returns in-progress for open PR", () => {
    expect(
      deriveStatus({
        githubData: {
          type: "pr",
          merged: false,
          state: "open",
        } as GitHubData,
      })
    ).toBe("in-progress");
  });

  it("returns done for closed issue", () => {
    expect(
      deriveStatus({
        githubData: { type: "issue", state: "closed" } as GitHubData,
      })
    ).toBe("done");
  });

  it("returns in-progress for open issue", () => {
    expect(
      deriveStatus({
        githubData: { type: "issue", state: "open" } as GitHubData,
      })
    ).toBe("in-progress");
  });
});

describe("addContributor", () => {
  it("adds a new contributor", () => {
    const item = makeItem();
    const agent: AgentRef = {
      btcAddress: "bc1qnew",
      displayName: "New Agent",
      agentId: null,
    };
    addContributor(item, agent);
    expect(item.contributors).toHaveLength(2);
    expect(item.contributors[1]!.btcAddress).toBe("bc1qnew");
  });

  it("does not add duplicate contributor", () => {
    const item = makeItem();
    const agent: AgentRef = {
      btcAddress: "bc1qfounder",
      displayName: "Founder",
      agentId: null,
    };
    addContributor(item, agent);
    expect(item.contributors).toHaveLength(1);
  });

  it("handles null btcAddress gracefully", () => {
    const item = makeItem();
    addContributor(item, { btcAddress: "", displayName: "X", agentId: null });
    // Empty btcAddress should be rejected
    expect(item.contributors).toHaveLength(1);
  });

  it("initializes contributors array if missing", () => {
    const item = makeItem();
    (item as Record<string, unknown>).contributors = undefined;
    const agent: AgentRef = {
      btcAddress: "bc1qnew",
      displayName: "New Agent",
      agentId: null,
    };
    addContributor(item, agent);
    expect(item.contributors).toHaveLength(1);
    expect(item.contributors[0]!.btcAddress).toBe("bc1qnew");
  });

  it("preserves agentId when adding", () => {
    const item = makeItem();
    const agent: AgentRef = {
      btcAddress: "bc1qnew",
      displayName: "Agent With ID",
      agentId: "agent-123",
    };
    addContributor(item, agent);
    expect(item.contributors[1]!.agentId).toBe("agent-123");
  });
});

// =========================================================================
// 2. MENTION DETECTION
// =========================================================================

describe("getMatchTerms", () => {
  it("generates title term", () => {
    const item = makeItem({ title: "AIBTC Projects" });
    const terms = getMatchTerms(item);
    expect(terms.some((t) => t.text === "aibtc projects" && t.type === "title")).toBe(true);
  });

  it("splits title on em-dash", () => {
    const item = makeItem({ title: "AIBTC — Projects Board" });
    const terms = getMatchTerms(item);
    expect(terms.some((t) => t.text === "projects board" && t.type === "title")).toBe(true);
  });

  it("splits title on en-dash", () => {
    const item = makeItem({ title: "AIBTC – Projects Board" });
    const terms = getMatchTerms(item);
    expect(terms.some((t) => t.text === "projects board" && t.type === "title")).toBe(true);
  });

  it("splits title on pipe", () => {
    const item = makeItem({ title: "AIBTC | Projects Board" });
    const terms = getMatchTerms(item);
    expect(terms.some((t) => t.text === "projects board" && t.type === "title")).toBe(true);
  });

  it("generates slug variants", () => {
    const item = makeItem({ title: "AIBTC Projects" });
    const terms = getMatchTerms(item);
    expect(terms.some((t) => t.type === "slug")).toBe(true);
  });

  it("generates GitHub URL variants", () => {
    const item = makeItem({
      githubUrl: "https://github.com/aibtcdev/aibtc-projects",
    });
    const terms = getMatchTerms(item);
    // Full URL
    expect(
      terms.some(
        (t) =>
          t.text === "https://github.com/aibtcdev/aibtc-projects" &&
          t.type === "url"
      )
    ).toBe(true);
    // Path-only
    expect(
      terms.some(
        (t) => t.text === "aibtcdev/aibtc-projects" && t.type === "url"
      )
    ).toBe(true);
    // Repo name (>=8 chars)
    expect(
      terms.some((t) => t.text === "aibtc-projects" && t.type === "url")
    ).toBe(true);
    // Repo name spaced
    expect(
      terms.some((t) => t.text === "aibtc projects" && t.type === "url")
    ).toBe(true);
  });

  it("skips short repo names (< 8 chars)", () => {
    const item = makeItem({
      title: "Skills",
      githubUrl: "https://github.com/aibtcdev/skills",
    });
    const terms = getMatchTerms(item);
    // "skills" is 6 chars — should NOT appear as a URL term
    expect(
      terms.filter((t) => t.text === "skills" && t.type === "url")
    ).toHaveLength(0);
  });

  it("includes custom searchTerms as alias type", () => {
    const item = makeItem({ searchTerms: ["roadmap", "project board"] });
    const terms = getMatchTerms(item);
    expect(
      terms.some((t) => t.text === "roadmap" && t.type === "alias")
    ).toBe(true);
    expect(
      terms.some((t) => t.text === "project board" && t.type === "alias")
    ).toBe(true);
  });

  it("skips short searchTerms (<=2 chars)", () => {
    const item = makeItem({ searchTerms: ["AB", "ok", "valid-term"] });
    const terms = getMatchTerms(item);
    expect(terms.some((t) => t.text === "AB")).toBe(false);
    expect(terms.some((t) => t.text === "ok")).toBe(false);
    expect(terms.some((t) => t.text === "valid-term")).toBe(true);
  });

  it("deduplicates terms", () => {
    const item = makeItem({
      title: "aibtc-projects",
      githubUrl: "https://github.com/aibtcdev/aibtc-projects",
    });
    const terms = getMatchTerms(item);
    const texts = terms.map((t) => t.text);
    const uniqueTexts = new Set(texts);
    expect(texts.length).toBe(uniqueTexts.size);
  });

  it("filters title parts <=3 chars", () => {
    const item = makeItem({ title: "AIBTC — X" });
    const terms = getMatchTerms(item);
    // "x" is too short, should not appear as a split title part
    expect(terms.filter((t) => t.text === "x" && t.type === "title")).toHaveLength(0);
  });
});

describe("matchMention", () => {
  const item = makeItem({
    title: "AIBTC Projects",
    githubUrl: "https://github.com/aibtcdev/aibtc-projects",
    searchTerms: [],
  });

  it("matches by full title (case-insensitive)", () => {
    expect(matchMention("check out aibtc projects today", item)).toBe(
      "title"
    );
  });

  it("matches by slug", () => {
    expect(matchMention("look at aibtc-projects board", item)).toBe("slug");
  });

  it("matches by GitHub URL (slug term wins when repo name equals slug)", () => {
    // "aibtc-projects" appears as both slug and url term; slug is checked first
    expect(
      matchMention(
        "see https://github.com/aibtcdev/aibtc-projects for details",
        item
      )
    ).toBe("slug");
  });

  it("matches by repo path (slug term wins)", () => {
    expect(
      matchMention("check aibtcdev/aibtc-projects repo", item)
    ).toBe("slug");
  });

  it("matches by url when repo name differs from title slug", () => {
    const differentItem = makeItem({
      title: "Projects Board",
      githubUrl: "https://github.com/aibtcdev/aibtc-roadmap-app",
    });
    // "aibtc-roadmap-app" is >=8 chars and only added as url term
    expect(
      matchMention("check out aibtc-roadmap-app here", differentItem)
    ).toBe("url");
  });

  it("matches by custom alias", () => {
    const itemWithAlias = makeItem({
      title: "Some Project",
      githubUrl: "https://github.com/aibtcdev/some-project-repo",
      searchTerms: ["roadmap board"],
    });
    expect(matchMention("updated the roadmap board today", itemWithAlias)).toBe(
      "alias"
    );
  });

  it("returns null on no match", () => {
    expect(matchMention("nothing relevant here at all", item)).toBeNull();
  });

  it("returns null for empty message", () => {
    expect(matchMention("", item)).toBeNull();
  });
});

// =========================================================================
// 3. WEBSITE DISCOVERY
// =========================================================================

describe("isDeploymentUrl", () => {
  it("returns 0 for noise hosts", () => {
    expect(isDeploymentUrl("https://github.com/repo")).toBe(0);
    expect(isDeploymentUrl("https://www.npmjs.com/package/foo")).toBe(0);
    expect(isDeploymentUrl("https://img.shields.io/badge/x")).toBe(0);
    expect(isDeploymentUrl("https://pypi.org/project/x")).toBe(0);
    expect(isDeploymentUrl("https://crates.io/crates/x")).toBe(0);
    expect(isDeploymentUrl("https://localhost:3000")).toBe(0);
    expect(isDeploymentUrl("https://example.com")).toBe(0);
    expect(isDeploymentUrl("https://bun.sh/docs")).toBe(0);
  });

  it("returns 0 for noise URL paths", () => {
    expect(isDeploymentUrl("https://aibtc.com/agents/arc")).toBe(0);
    expect(isDeploymentUrl("https://somesite.com/api/v1/data")).toBe(0);
    expect(isDeploymentUrl("https://somesite.com/install")).toBe(0);
    expect(isDeploymentUrl("https://somesite.com/raw/file")).toBe(0);
  });

  it("scores Cloudflare Pages (10)", () => {
    expect(isDeploymentUrl("https://my-app.pages.dev")).toBe(10);
  });

  it("scores Vercel (10)", () => {
    expect(isDeploymentUrl("https://my-app.vercel.app")).toBe(10);
  });

  it("scores Netlify (10)", () => {
    expect(isDeploymentUrl("https://my-app.netlify.app")).toBe(10);
  });

  it("scores Workers.dev (9)", () => {
    expect(isDeploymentUrl("https://my-api.workers.dev")).toBe(9);
  });

  it("scores Heroku (8)", () => {
    expect(isDeploymentUrl("https://my-app.herokuapp.com")).toBe(8);
  });

  it("scores Fly.dev (8)", () => {
    expect(isDeploymentUrl("https://my-app.fly.dev")).toBe(8);
  });

  it("scores Firebase (8)", () => {
    expect(isDeploymentUrl("https://my-app.web.app")).toBe(8);
    expect(isDeploymentUrl("https://my-app.firebaseapp.com")).toBe(8);
  });

  it("scores Render (8)", () => {
    expect(isDeploymentUrl("https://my-app.onrender.com")).toBe(8);
  });

  it("scores Surge.sh (7)", () => {
    expect(isDeploymentUrl("https://my-app.surge.sh")).toBe(7);
  });

  it("scores GitHub Pages (7)", () => {
    expect(isDeploymentUrl("https://user.github.io")).toBe(7);
  });

  it("scores custom domains (6)", () => {
    expect(isDeploymentUrl("https://myapp.com")).toBe(6);
    expect(isDeploymentUrl("https://dashboard.mycompany.org")).toBe(6);
  });

  it("returns 0 for invalid URLs", () => {
    expect(isDeploymentUrl("not a url")).toBe(0);
    expect(isDeploymentUrl("")).toBe(0);
  });
});

describe("extractUrlsFromText", () => {
  it("extracts HTTP URLs from text", () => {
    const text = "Visit https://example.com and http://other.com for info";
    const urls = extractUrlsFromText(text);
    expect(urls).toContain("https://example.com");
    expect(urls).toContain("http://other.com");
  });

  it("strips trailing punctuation", () => {
    const text = "See https://example.com. Also https://other.com)";
    const urls = extractUrlsFromText(text);
    expect(urls).toContain("https://example.com");
    expect(urls).toContain("https://other.com");
  });

  it("returns empty array for text without URLs", () => {
    expect(extractUrlsFromText("no urls here")).toEqual([]);
  });

  it("returns empty array for empty/null input", () => {
    expect(extractUrlsFromText("")).toEqual([]);
  });

  it("handles multiple URLs on same line", () => {
    const text =
      "https://a.com https://b.com https://c.com";
    const urls = extractUrlsFromText(text);
    expect(urls).toHaveLength(3);
  });
});

describe("extractUrlFromReadme", () => {
  it("finds deployment URL from README content", () => {
    const content = `
# My Project

Visit the live demo at https://my-app.vercel.app

## Getting Started
...
    `;
    const url = extractUrlFromReadme(content);
    expect(url).toBe("https://my-app.vercel.app");
  });

  it("scores higher with context keywords", () => {
    const content = `
Visit the live demo: https://my-app.vercel.app

Credits: Built by https://developer.pages.dev
    `;
    // "live demo" is a context keyword → bonus
    // "Built by" is a negative keyword → penalty
    const url = extractUrlFromReadme(content);
    expect(url).toBe("https://my-app.vercel.app");
  });

  it("returns null when no deployment URLs found", () => {
    const content = "Check https://github.com/repo and https://npmjs.com/foo";
    expect(extractUrlFromReadme(content)).toBeNull();
  });

  it("returns null for empty content", () => {
    expect(extractUrlFromReadme("")).toBeNull();
    expect(extractUrlFromReadme(null as unknown as string)).toBeNull();
  });

  it("skips URLs in the skipUrls set", () => {
    const content = "Visit https://my-app.vercel.app for the demo";
    const skipUrls = new Set(["https://my-app.vercel.app"]);
    expect(extractUrlFromReadme(content, skipUrls)).toBeNull();
  });

  it("requires minimum score of 5", () => {
    // A custom domain with no context keywords scores 6 — should pass
    const content = "Visit https://myproject.io for details";
    const url = extractUrlFromReadme(content);
    expect(url).toBe("https://myproject.io");
  });
});

describe("extractUrlFromDescription", () => {
  it("returns best deployment URL from description", () => {
    const url = extractUrlFromDescription(
      "Project dashboard at https://my-app.pages.dev"
    );
    expect(url).toBe("https://my-app.pages.dev");
  });

  it("returns null for null/empty descriptions", () => {
    expect(extractUrlFromDescription(null)).toBeNull();
    expect(extractUrlFromDescription(undefined)).toBeNull();
    expect(extractUrlFromDescription("")).toBeNull();
  });

  it("picks highest-scored URL when multiple present", () => {
    const desc =
      "https://my-app.surge.sh and https://my-app.pages.dev";
    const url = extractUrlFromDescription(desc);
    // pages.dev (10) beats surge.sh (7)
    expect(url).toBe("https://my-app.pages.dev");
  });

  it("skips URLs in the skipUrls set", () => {
    const desc = "Visit https://my-app.pages.dev";
    const skipUrls = new Set(["https://my-app.pages.dev"]);
    expect(extractUrlFromDescription(desc, skipUrls)).toBeNull();
  });
});

describe("extractUrlFromMessages", () => {
  const item = makeItem({
    title: "AIBTC Projects",
    githubUrl: "https://github.com/aibtcdev/aibtc-projects",
  });

  it("finds most-mentioned deployment URL in matching messages", () => {
    const messages = [
      {
        messagePreview:
          "Check out AIBTC Projects at https://my-app.pages.dev",
      },
      {
        messagePreview:
          "aibtc projects is live at https://my-app.pages.dev",
      },
      {
        messagePreview:
          "aibtc projects also at https://other.vercel.app",
      },
    ];
    const url = extractUrlFromMessages(messages, item);
    // my-app.pages.dev mentioned 2x, other.vercel.app 1x
    expect(url).toBe("https://my-app.pages.dev");
  });

  it("returns null for empty messages", () => {
    expect(extractUrlFromMessages([], item)).toBeNull();
  });

  it("returns null when no messages mention the item", () => {
    const messages = [
      { messagePreview: "something unrelated https://x.pages.dev" },
    ];
    expect(extractUrlFromMessages(messages, item)).toBeNull();
  });

  it("ignores noise URLs in messages", () => {
    const messages = [
      {
        messagePreview:
          "check aibtc projects at https://github.com/aibtcdev/aibtc-projects",
      },
    ];
    expect(extractUrlFromMessages(messages, item)).toBeNull();
  });

  it("ignores self-hosted URLs", () => {
    const messages = [
      {
        messagePreview:
          "aibtc projects at https://aibtc-projects.pages.dev",
      },
    ];
    expect(extractUrlFromMessages(messages, item)).toBeNull();
  });
});

// =========================================================================
// 4. ALARM SCHEDULING
// =========================================================================

describe("ALARM_CHAIN", () => {
  it("contains all 6 alarm tasks", () => {
    expect(ALARM_CHAIN).toHaveLength(6);
    expect(ALARM_CHAIN).toContain("github-refresh");
    expect(ALARM_CHAIN).toContain("mention-scan");
    expect(ALARM_CHAIN).toContain("contributor-scan");
    expect(ALARM_CHAIN).toContain("pr-scan");
    expect(ALARM_CHAIN).toContain("website-discovery");
    expect(ALARM_CHAIN).toContain("backfill-mentions");
  });

  it("starts with github-refresh", () => {
    expect(ALARM_CHAIN[0]).toBe("github-refresh");
  });

  it("ends with backfill-mentions", () => {
    expect(ALARM_CHAIN[ALARM_CHAIN.length - 1]).toBe("backfill-mentions");
  });
});

describe("ALARM_SCHEDULE", () => {
  it("maps every chain task to an interval", () => {
    for (const task of ALARM_CHAIN) {
      expect(ALARM_SCHEDULE[task]).toBeGreaterThan(0);
    }
  });

  it("has correct intervals", () => {
    expect(ALARM_SCHEDULE["github-refresh"]).toBe(15);
    expect(ALARM_SCHEDULE["mention-scan"]).toBe(10);
    expect(ALARM_SCHEDULE["contributor-scan"]).toBe(15);
    expect(ALARM_SCHEDULE["pr-scan"]).toBe(15);
    expect(ALARM_SCHEDULE["website-discovery"]).toBe(30);
    expect(ALARM_SCHEDULE["backfill-mentions"]).toBe(60);
  });
});

describe("alarm round-robin logic", () => {
  function getNextAlarmTask(
    lastTask: string | null
  ): string {
    if (!lastTask) return ALARM_CHAIN[0]!;
    const idx = ALARM_CHAIN.indexOf(lastTask as typeof ALARM_CHAIN[number]);
    return ALARM_CHAIN[(idx + 1) % ALARM_CHAIN.length]!;
  }

  it("starts with first task when no last task", () => {
    expect(getNextAlarmTask(null)).toBe("github-refresh");
  });

  it("advances through the chain", () => {
    expect(getNextAlarmTask("github-refresh")).toBe("mention-scan");
    expect(getNextAlarmTask("mention-scan")).toBe("contributor-scan");
    expect(getNextAlarmTask("contributor-scan")).toBe("pr-scan");
    expect(getNextAlarmTask("pr-scan")).toBe("website-discovery");
    expect(getNextAlarmTask("website-discovery")).toBe("backfill-mentions");
  });

  it("wraps around from last to first", () => {
    expect(getNextAlarmTask("backfill-mentions")).toBe("github-refresh");
  });

  it("completes full cycle", () => {
    let task: string | null = null;
    const visited: string[] = [];
    for (let i = 0; i < ALARM_CHAIN.length; i++) {
      task = getNextAlarmTask(task);
      visited.push(task);
    }
    expect(visited).toEqual(ALARM_CHAIN);
  });
});

// =========================================================================
// 5. CONSTANTS
// =========================================================================

describe("constants", () => {
  it("STALE_AFTER_MS is 15 minutes", () => {
    expect(STALE_AFTER_MS).toBe(15 * 60 * 1000);
  });

  it("MAX_EVENTS is 200", () => {
    expect(MAX_EVENTS).toBe(200);
  });

  it("MAX_ARCHIVED_MESSAGES is 2000", () => {
    expect(MAX_ARCHIVED_MESSAGES).toBe(2000);
  });

  it("SEED_GITHUB_MAPPINGS has known agents", () => {
    expect(SEED_GITHUB_MAPPINGS["arc0btc"]).toBe(
      "bc1qlezz2cgktx0t680ymrytef92wxksywx0jaw933"
    );
    expect(SEED_GITHUB_MAPPINGS["cedarxyz"]).toBeDefined();
    expect(SEED_GITHUB_MAPPINGS["secret-mars"]).toBeDefined();
  });
});

describe("STORAGE_KEYS", () => {
  it("has correct key prefixes", () => {
    expect(STORAGE_KEYS.projectPrefix).toBe("project:");
    expect(STORAGE_KEYS.projectOrder).toBe("meta:projectOrder");
    expect(STORAGE_KEYS.schemaVersion).toBe("meta:schemaVersion");
    expect(STORAGE_KEYS.migrated).toBe("meta:migrated");
    expect(STORAGE_KEYS.alarmMeta).toBe("meta:alarm");
    expect(STORAGE_KEYS.eventPrefix).toBe("event:");
    expect(STORAGE_KEYS.mentionScan).toBe("scan:mentions");
    expect(STORAGE_KEYS.githubScan).toBe("scan:github");
    expect(STORAGE_KEYS.githubMap).toBe("scan:github-map");
    expect(STORAGE_KEYS.messageArchive).toBe("scan:messages");
    expect(STORAGE_KEYS.agentCachePrefix).toBe("agent-cache:");
  });
});

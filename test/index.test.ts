import { describe, it, expect } from "vitest";
import { parseGithubUrl, deriveStatus } from "../src/tasks/github";
import { getMatchTerms, matchMention } from "../src/tasks/mentions";
import type { ProjectItem } from "../src/lib/types";

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

  it("returns null for non-GitHub URLs", () => {
    expect(parseGithubUrl("https://example.com")).toBeNull();
    expect(parseGithubUrl(null)).toBeNull();
    expect(parseGithubUrl("")).toBeNull();
  });
});

describe("deriveStatus", () => {
  it("returns todo when no github data", () => {
    expect(deriveStatus({})).toBe("todo");
    expect(deriveStatus({ githubData: null })).toBe("todo");
  });

  it("returns in-progress for active repo", () => {
    expect(
      deriveStatus({
        githubData: { type: "repo", state: "active" } as never,
      })
    ).toBe("in-progress");
  });

  it("returns done for archived repo", () => {
    expect(
      deriveStatus({
        githubData: { type: "repo", state: "archived" } as never,
      })
    ).toBe("done");
  });

  it("returns done for merged PR", () => {
    expect(
      deriveStatus({
        githubData: { type: "pr", merged: true, state: "closed" } as never,
      })
    ).toBe("done");
  });

  it("returns blocked for closed unmerged PR", () => {
    expect(
      deriveStatus({
        githubData: { type: "pr", merged: false, state: "closed" } as never,
      })
    ).toBe("blocked");
  });
});

describe("matchMention", () => {
  const item = {
    title: "AIBTC Projects",
    githubUrl: "https://github.com/aibtcdev/aibtc-projects",
    searchTerms: [],
  } as unknown as ProjectItem;

  it("matches by title", () => {
    expect(matchMention("check out aibtc projects today", item)).toBe("title");
  });

  it("matches by slug", () => {
    expect(matchMention("look at aibtc-projects board", item)).toBe("slug");
  });

  it("returns null on no match", () => {
    expect(matchMention("nothing relevant here", item)).toBeNull();
  });
});

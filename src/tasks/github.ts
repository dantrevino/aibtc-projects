import type { Env, GitHubData } from "../lib/types";

/**
 * Parse a GitHub URL into its components.
 * Matches: github.com/owner/repo, github.com/owner/repo/issues/N, github.com/owner/repo/pull/N
 */
export function parseGithubUrl(
  url: string | null | undefined
): { owner: string; repo: string; type: "repo" | "issue" | "pr"; number: number | null } | null {
  if (!url) return null;

  const issueOrPr = url.match(
    /github\.com\/([^/]+)\/([^/]+)\/(issues|pull)\/(\d+)/
  );
  if (issueOrPr) {
    return {
      owner: issueOrPr[1]!,
      repo: issueOrPr[2]!,
      type: issueOrPr[3] === "pull" ? "pr" : "issue",
      number: parseInt(issueOrPr[4]!, 10),
    };
  }

  const repo = url.match(/github\.com\/([^/]+)\/([^/?#]+)/);
  if (repo) {
    return { owner: repo[1]!, repo: repo[2]!, type: "repo", number: null };
  }

  return null;
}

/** Fetch GitHub metadata for a URL */
export async function fetchGithubData(
  url: string,
  env: Env
): Promise<GitHubData | null> {
  try {
    const parsed = parseGithubUrl(url);
    if (!parsed) return null;

    let endpoint: string;
    if (parsed.type === "repo") {
      endpoint = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}`;
    } else if (parsed.type === "pr") {
      endpoint = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/pulls/${parsed.number}`;
    } else {
      endpoint = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/issues/${parsed.number}`;
    }

    const headers: Record<string, string> = {
      "User-Agent": "aibtc-projects/2.0",
      Accept: "application/vnd.github+json",
    };
    if (env.GITHUB_TOKEN) {
      headers["Authorization"] = `Bearer ${env.GITHUB_TOKEN}`;
    }

    const res = await fetch(endpoint, { headers });
    if (!res.ok) {
      if (res.status === 404) return { _notFound: true } as unknown as GitHubData;
      return null;
    }

    const d = (await res.json()) as Record<string, unknown>;

    if (parsed.type === "repo") {
      return {
        type: "repo",
        number: null,
        title: (d.description as string) || (d.full_name as string),
        state: (d.archived as boolean) ? "archived" : "active",
        merged: false,
        assignees: [],
        labels: (d.topics as string[]) || [],
        stars: d.stargazers_count as number,
        homepage: (d.homepage as string) || null,
        ownerLogin: (d.owner as Record<string, string>)?.login || null,
        fetchedAt: new Date().toISOString(),
      };
    }

    return {
      type: parsed.type,
      number: parsed.number,
      title: d.title as string,
      state: d.state as string,
      merged: (d.merged as boolean) || false,
      assignees: ((d.assignees as Array<{ login: string }>) || []).map(
        (a) => a.login
      ),
      labels: ((d.labels as Array<{ name: string }>) || []).map((l) => l.name),
      fetchedAt: new Date().toISOString(),
    };
  } catch (err) {
    console.error("[fetchGithubData]", url, err);
    return null;
  }
}

/** Derive project status from GitHub state */
export function deriveStatus(
  item: { githubData?: GitHubData | null }
): "todo" | "in-progress" | "done" | "blocked" {
  const gd = item.githubData;
  if (!gd || !gd.type) return "todo";
  if (gd.type === "repo")
    return gd.state === "archived" ? "done" : "in-progress";
  if (gd.type === "pr") {
    if (gd.merged) return "done";
    if (gd.state === "closed") return "blocked";
    return "in-progress";
  }
  return gd.state === "closed" ? "done" : "in-progress";
}

import type { ProjectItem } from "../lib/types";
import { matchMention } from "./mentions";

// Hosts that should never be treated as project deployment URLs
const NOISE_HOSTS = new Set([
  "github.com",
  "www.github.com",
  "docs.github.com",
  "raw.githubusercontent.com",
  "user-images.githubusercontent.com",
  "avatars.githubusercontent.com",
  "camo.githubusercontent.com",
  "npmjs.com",
  "www.npmjs.com",
  "shields.io",
  "img.shields.io",
  "badge.fury.io",
  "coveralls.io",
  "codecov.io",
  "travis-ci.org",
  "travis-ci.com",
  "circleci.com",
  "david-dm.org",
  "gitter.im",
  "localhost",
  "example.com",
  "crates.io",
  "pypi.org",
  "rubygems.org",
  "bun.sh",
  "bun.com",
  "deno.land",
  "deno.com",
  "nodejs.org",
]);

// URL path patterns that indicate non-deployment pages
const NOISE_PATHS = [
  /^\/agents\//, // aibtc.com agent profile links
  /^\/api\//, // API endpoints
  /^\/install\b/, // install scripts
  /^\/raw\//, // raw file endpoints
];

// URLs belonging to this application itself — excluded from deliverable/message sources
const SELF_HOSTS = new Set(["aibtc-projects.pages.dev"]);

const URL_CONTEXT_KEYWORDS =
  /\b(live|demo|website|deployed|homepage|visit|hosted|app|try it|production|dashboard)\b/i;
const URL_NEGATIVE_KEYWORDS =
  /\b(built by|created by|credits|author|maintained by|made by|powered by)\b/i;

/** Score a URL as a deployment URL. Returns 0 for noise, higher for likely deployments. */
export function isDeploymentUrl(url: string): number {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (NOISE_HOSTS.has(host)) return 0;
    if (NOISE_PATHS.some((p) => p.test(parsed.pathname))) return 0;
    if (host.endsWith(".pages.dev")) return 10;
    if (host.endsWith(".vercel.app")) return 10;
    if (host.endsWith(".netlify.app")) return 10;
    if (host.endsWith(".workers.dev")) return 9;
    if (host.endsWith(".herokuapp.com")) return 8;
    if (host.endsWith(".fly.dev")) return 8;
    if (host.endsWith(".web.app") || host.endsWith(".firebaseapp.com")) return 8;
    if (host.endsWith(".onrender.com")) return 8;
    if (host.endsWith(".surge.sh")) return 7;
    if (host.endsWith(".github.io")) return 7;
    // Custom domains (not a known noise host)
    if (!host.includes("github") && !host.includes("npm")) return 6;
    return 0;
  } catch {
    return 0;
  }
}

/** Extract HTTP(S) URLs from text */
export function extractUrlsFromText(text: string): string[] {
  if (!text) return [];
  const matches = text.match(/https?:\/\/[^\s<>\[\]()'"`,;]+/gi) || [];
  return matches.map((u) => u.replace(/[.)]+$/, ""));
}

/** Extract best deployment URL from README content */
export function extractUrlFromReadme(
  content: string,
  skipUrls: Set<string> = new Set()
): string | null {
  if (!content) return null;
  const urls = extractUrlsFromText(content);
  if (urls.length === 0) return null;

  const scored = urls
    .map((url) => ({ url, score: isDeploymentUrl(url) }))
    .filter((u) => u.score > 0 && !skipUrls.has(u.url));
  if (scored.length === 0) return null;

  // Bonus for URLs near contextual keywords, penalty near credits/author sections
  for (const s of scored) {
    const idx = content.indexOf(s.url);
    if (idx !== -1) {
      const ctx = content.slice(Math.max(0, idx - 200), idx);
      if (URL_CONTEXT_KEYWORDS.test(ctx)) s.score += 5;
      if (URL_NEGATIVE_KEYWORDS.test(ctx)) s.score -= 4;
    }
  }

  // Require minimum score of 5
  const best = scored
    .filter((s) => s.score >= 5)
    .sort((a, b) => b.score - a.score);
  return best.length > 0 ? best[0]!.url : null;
}

/** Extract best deployment URL from a GitHub description */
export function extractUrlFromDescription(
  description: string | undefined | null,
  skipUrls: Set<string> = new Set()
): string | null {
  if (!description) return null;
  const urls = extractUrlsFromText(description);
  const scored = urls
    .map((url) => ({ url, score: isDeploymentUrl(url) }))
    .filter((u) => u.score > 0 && !skipUrls.has(u.url));
  if (scored.length === 0) return null;
  scored.sort((a, b) => b.score - a.score);
  return scored[0]!.url;
}

/** Extract most-mentioned deployment URL from message archive for a given item */
export function extractUrlFromMessages(
  messages: Array<{ messagePreview?: string | null }>,
  item: ProjectItem
): string | null {
  if (!messages || messages.length === 0) return null;
  const urlCounts = new Map<string, number>();

  for (const msg of messages) {
    const preview = (msg.messagePreview || "").toLowerCase();
    if (!matchMention(preview, item)) continue;
    const urls = extractUrlsFromText(msg.messagePreview || "");
    for (const url of urls) {
      if (isDeploymentUrl(url) === 0) continue;
      try {
        if (SELF_HOSTS.has(new URL(url).hostname.toLowerCase())) continue;
      } catch {
        /* skip invalid URLs */
      }
      urlCounts.set(url, (urlCounts.get(url) || 0) + 1);
    }
  }

  if (urlCounts.size === 0) return null;
  let best: string | null = null;
  let bestCount = 0;
  for (const [url, count] of urlCounts) {
    if (
      count > bestCount ||
      (count === bestCount && isDeploymentUrl(url) > isDeploymentUrl(best || ""))
    ) {
      best = url;
      bestCount = count;
    }
  }
  return best;
}

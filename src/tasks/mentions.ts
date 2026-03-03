import type { ProjectItem } from "../lib/types";

/** Match term for mention detection */
interface MatchTerm {
  text: string;
  type: "title" | "slug" | "url" | "site" | "alias";
}

/** Build match terms for an item, ordered by specificity */
export function getMatchTerms(item: ProjectItem): MatchTerm[] {
  const terms: MatchTerm[] = [];
  const titleLower = (item.title || "").toLowerCase();

  if (titleLower) terms.push({ text: titleLower, type: "title" });

  // Title parts split on em-dash/en-dash/pipe
  const titleParts = titleLower
    .split(/\s*[—–|]\s*/)
    .map((p) => p.trim())
    .filter((p) => p.length > 3);
  for (const part of titleParts) {
    if (part !== titleLower) terms.push({ text: part, type: "title" });
  }

  // Slugified versions
  for (const part of [titleLower, ...titleParts]) {
    const slug = part
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    if (slug.length > 3 && slug !== part)
      terms.push({ text: slug, type: "slug" });
  }

  // GitHub URL variants
  const ghPath = item.githubUrl
    ? item.githubUrl
        .replace(/^https?:\/\/(www\.)?github\.com\//, "")
        .replace(/\/$/, "")
        .toLowerCase()
    : null;
  if (ghPath) {
    terms.push({ text: item.githubUrl.toLowerCase(), type: "url" });
    terms.push({ text: ghPath, type: "url" });
    const repoName = ghPath.split("/").pop();
    if (repoName && repoName.length >= 8) {
      terms.push({ text: repoName, type: "url" });
      const repoSpaced = repoName.replace(/-/g, " ");
      if (repoSpaced !== repoName)
        terms.push({ text: repoSpaced, type: "url" });
    }
  }

  // Custom search terms
  if (Array.isArray(item.searchTerms)) {
    for (const t of item.searchTerms) {
      if (t.length > 2) terms.push({ text: t, type: "alias" });
    }
  }

  // Deduplicate
  const seen = new Set<string>();
  return terms.filter((t) => {
    if (seen.has(t.text)) return false;
    seen.add(t.text);
    return true;
  });
}

/** Check if a lowercased message preview mentions a specific item */
export function matchMention(
  preview: string,
  item: ProjectItem
): string | null {
  const terms = getMatchTerms(item);
  for (const term of terms) {
    if (preview.includes(term.text)) return term.type;
  }
  return null;
}

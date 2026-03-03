/** KV key for the main roadmap data */
export const KV_KEY = "roadmap:items";

/** KV key for activity events */
export const EVENTS_KEY = "roadmap:events";

/** KV key for mention scan metadata */
export const MENTION_SCAN_KEY = "roadmap:mention-scan";

/** KV key for message archive */
export const MESSAGE_ARCHIVE_KEY = "roadmap:message-archive";

/** KV key for GitHub scan state */
export const GITHUB_SCAN_KEY = "roadmap:github-scan";

/** KV key for GitHub username→agent mapping */
export const GITHUB_MAP_KEY = "roadmap:github-map";

/** Data staleness threshold — 15 minutes */
export const STALE_AFTER_MS = 15 * 60 * 1000;

/** Mention scan cooldown — 10 minutes */
export const MENTION_SCAN_COOLDOWN_MS = 10 * 60 * 1000;

/** GitHub scan cooldown — 15 minutes */
export const GITHUB_SCAN_COOLDOWN_MS = 15 * 60 * 1000;

/** Website scan cooldown — 1 hour */
export const WEBSITE_SCAN_COOLDOWN_MS = 60 * 60 * 1000;

/** Maximum archived messages */
export const MAX_ARCHIVED_MESSAGES = 2000;

/** Maximum activity events */
export const MAX_EVENTS = 200;

/** Time budget for refresh endpoint — 50s */
export const TIME_BUDGET_MS = 50_000;

/** Known GitHub username → AIBTC agent BTC address */
export const SEED_GITHUB_MAPPINGS: Record<string, string> = {
  cedarxyz: "bc1q7zpy3kpxjzrfctz4en9k2h5sp8nwhctgz54sn5",
  "secret-mars": "bc1qqaxq5vxszt0lzmr9gskv4lcx7jzrg772s4vxpp",
  cocoa007: "bc1qv8dt3v9kx3l7r9mnz2gj9r9n9k63frn6w6zmrt",
  "sonic-mast": "bc1qd0z0a8z8am9j84fk3lk5g2hutpxcreypnf2p47",
  arc0btc: "bc1qlezz2cgktx0t680ymrytef92wxksywx0jaw933",
};

import { Hono } from "hono";
import type { Env } from "../lib/types";
import { getProject } from "../lib/do-client";
import { getMessageArchive } from "../lib/do-client";
import { matchMention } from "../tasks/mentions";

export const mentions = new Hono<{ Bindings: Env }>();

// GET /api/mentions?itemId=... — mention details for a project
mentions.get("/", async (c) => {
  const itemId = c.req.query("itemId");
  if (!itemId) {
    return c.json({ error: "itemId is required" }, 400);
  }

  const item = await getProject(c.env, itemId);
  if (!item) {
    return c.json({ error: "Project not found" }, 404);
  }

  // Scan message archive for mentions of this project
  const archive = await getMessageArchive(c.env);
  const mentionResults: Array<{
    messageId: string;
    preview: string;
    matchType: string;
    timestamp: string;
  }> = [];

  for (const msg of archive.messages) {
    const preview =
      (msg.data?.messagePreview as string) ??
      (msg.data?.preview as string) ??
      "";
    if (!preview) continue;

    const matchType = matchMention(preview.toLowerCase(), item);
    if (matchType) {
      mentionResults.push({
        messageId: msg.id,
        preview,
        matchType,
        timestamp: msg.timestamp,
      });
    }
  }

  return c.json({
    itemId,
    itemTitle: item.title,
    mentionCount: item.mentions.count,
    matches: mentionResults,
  });
});

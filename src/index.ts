import { Hono } from "hono";
import { cors } from "hono/cors";
import { items } from "./routes/items";
import { feed } from "./routes/feed";
import { mentions } from "./routes/mentions";
import { reorder } from "./routes/reorder";
import { refresh } from "./routes/refresh";
import type { Env, AuthVariables } from "./lib/types";
import { authMiddleware } from "./lib/auth";
import { ProjectsDurableObject } from "./objects/projects";

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

// Global CORS
app.use("*", cors());

// Global auth — resolves agent from Authorization header, attaches to context.
// Does not block unauthenticated requests; routes use requireAuth for that.
app.use("/api/*", authMiddleware);

// Health check
app.get("/", (c) => c.json({ name: "aibtc-projects", version: "2.0.0" }));

// API routes
app.route("/api/items", items);
app.route("/api/feed", feed);
app.route("/api/mentions", mentions);
app.route("/api/reorder", reorder);
app.route("/api/refresh", refresh);

// 404 fallback
app.notFound((c) => c.json({ error: "Not found" }, 404));

// Error handler
app.onError((err, c) => {
  console.error("[unhandled]", err);
  return c.json({ error: "Internal server error" }, 500);
});

export default app;
export { ProjectsDurableObject };

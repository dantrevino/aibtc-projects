import { DurableObject } from "cloudflare:workers";
import type { Env } from "../lib/types";

/**
 * ProjectsDurableObject — single-writer coordination for roadmap state.
 *
 * Replaces optimistic concurrency (writeVersion) from v1 with a proper
 * Durable Object that serializes writes. KV remains the read path;
 * DO is the write-through coordination layer.
 */
export class ProjectsDurableObject extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // TODO: implement write coordination
    // - POST /write — serialize KV writes through DO
    // - GET /health — liveness check

    if (url.pathname === "/health") {
      return Response.json({ ok: true });
    }

    return Response.json({ error: "Not implemented" }, { status: 501 });
  }
}

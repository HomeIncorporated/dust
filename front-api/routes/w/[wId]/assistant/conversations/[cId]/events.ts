import { workspaceApp } from "@front-api/middlewares/ctx";
import type { Context } from "hono";

// Mounted at /api/w/:wId/assistant/conversations/:cId/events.
//
// SSE endpoint: the actual handler lives at
// `front-api/routes/sse/w/[wId]/assistant/conversations/[cId]/events.ts`,
// so it can be served by the dedicated front-sse pods via the `/api/sse/`
// ingress rule. Hono only registers a 307 redirect here so the routing
// contract is the same whether the request first hits this entry or the
// `/api/sse/` mirror directly.
const app = workspaceApp();

const SSE_PREFIX = "/api/sse";

function redirectToSse(ctx: Context) {
  const url = new URL(ctx.req.url);
  const sseUrl = `${url.origin}${SSE_PREFIX}${url.pathname}${url.search}`;
  return ctx.redirect(sseUrl, 307);
}

app.get("/", redirectToSse);

export default app;

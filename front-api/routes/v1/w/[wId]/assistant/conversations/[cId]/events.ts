import { publicApiApp } from "@front-api/middlewares/ctx";
import type { Context } from "hono";

// Mounted at /api/v1/w/:wId/assistant/conversations/:cId/events.
//
// SSE endpoint: the actual handler lives at
// `front-api/routes/sse/v1/w/[wId]/assistant/conversations/[cId]/events.ts`,
// so it can be served by the dedicated front-sse pods via the `/api/sse/`
// ingress rule.
const app = publicApiApp();

const SSE_PREFIX = "/api/sse";

function redirectToSse(ctx: Context) {
  const url = new URL(ctx.req.url);
  const sseUrl = `${url.origin}${SSE_PREFIX}${url.pathname}${url.search}`;
  return ctx.redirect(sseUrl, 307);
}

app.get("/", redirectToSse);

export default app;

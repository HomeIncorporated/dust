import { Hono } from "hono";
import publicSseApp from "./v1/w/[wId]";
import privateSseApp from "./w/[wId]";

// Mounted at /api/sse. The /api/sse/ URL prefix lets ingress route SSE
// traffic to dedicated front-sse pods. Both private and public (v1) SSE
// endpoints live here; auth is applied inside each sub-app since they use
// different mechanisms (session vs. API key / bearer).
const app = new Hono();

app.route("/v1/w/:wId", publicSseApp);
app.route("/w/:wId", privateSseApp);

export default app;

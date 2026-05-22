import { publicApiApp } from "@front-api/middlewares/ctx";

import conversations from "./conversations";

// Mounted at /api/v1/w/:wId/assistant. Currently only carries SSE redirect
// stubs under /conversations; remaining /assistant routes are still in Next.
const app = publicApiApp();

app.route("/conversations", conversations);

export default app;

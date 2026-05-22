import { workspaceApp } from "@front-api/middlewares/ctx";
import { workspaceAuth } from "@front-api/middlewares/workspace_auth";

import assistant from "./assistant";
import mcp from "./mcp";

// Mounted at /api/sse/w/:wId. The /api/sse/ subtree lives outside the main
// /api/w/:wId workspace app, so we re-apply workspaceAuth at this boundary.
const app = workspaceApp();

app.use("*", workspaceAuth());

app.route("/assistant", assistant);
app.route("/mcp", mcp);

export default app;

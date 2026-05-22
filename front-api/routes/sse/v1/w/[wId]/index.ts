import { publicApiApp } from "@front-api/middlewares/ctx";
import { publicApiAuth } from "@front-api/middlewares/public_api_auth";

import assistant from "./assistant";
import mcp from "./mcp";

// Mounted at /api/sse/v1/w/:wId. The /api/sse/ subtree lives outside the main
// /api/v1/w/:wId public API app, so we re-apply publicApiAuth at this
// boundary.
const app = publicApiApp();

app.use("*", publicApiAuth);

app.route("/assistant", assistant);
app.route("/mcp", mcp);

export default app;

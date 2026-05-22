import { publicApiApp } from "@front-api/middlewares/ctx";

import requests from "./requests";

// Mounted at /api/v1/w/:wId/mcp. Currently only carries the SSE `requests`
// redirect stub; remaining /mcp routes are still in Next.
const app = publicApiApp();

app.route("/requests", requests);

export default app;

import { workspaceApp } from "@front-api/middlewares/ctx";

import conversations from "./conversations";

const app = workspaceApp();

app.route("/conversations", conversations);

export default app;

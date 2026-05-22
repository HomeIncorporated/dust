import { workspaceApp } from "@front-api/middlewares/ctx";

import conversation from "./[cId]";

const app = workspaceApp();

app.route("/:cId", conversation);

export default app;

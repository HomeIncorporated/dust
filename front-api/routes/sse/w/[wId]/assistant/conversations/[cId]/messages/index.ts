import { workspaceApp } from "@front-api/middlewares/ctx";

import message from "./[mId]";

const app = workspaceApp();

app.route("/:mId", message);

export default app;

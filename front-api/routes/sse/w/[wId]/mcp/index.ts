import { workspaceApp } from "@front-api/middlewares/ctx";

import requests from "./requests";

const app = workspaceApp();

app.route("/requests", requests);

export default app;

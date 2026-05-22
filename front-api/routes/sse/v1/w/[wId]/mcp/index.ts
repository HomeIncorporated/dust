import { publicApiApp } from "@front-api/middlewares/ctx";

import requests from "./requests";

const app = publicApiApp();

app.route("/requests", requests);

export default app;

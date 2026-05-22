import { publicApiApp } from "@front-api/middlewares/ctx";

import events from "./events";

const app = publicApiApp();

app.route("/events", events);

export default app;

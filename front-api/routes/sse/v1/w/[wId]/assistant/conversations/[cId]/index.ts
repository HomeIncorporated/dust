import { publicApiApp } from "@front-api/middlewares/ctx";

import events from "./events";
import messages from "./messages";

const app = publicApiApp();

app.route("/events", events);
app.route("/messages", messages);

export default app;

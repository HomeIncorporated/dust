import { publicApiApp } from "@front-api/middlewares/ctx";

import conversations from "./conversations";

const app = publicApiApp();

app.route("/conversations", conversations);

export default app;

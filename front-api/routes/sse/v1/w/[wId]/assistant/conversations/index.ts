import { publicApiApp } from "@front-api/middlewares/ctx";

import conversation from "./[cId]";

const app = publicApiApp();

app.route("/:cId", conversation);

export default app;

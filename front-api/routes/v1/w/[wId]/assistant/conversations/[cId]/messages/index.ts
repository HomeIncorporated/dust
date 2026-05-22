import { publicApiApp } from "@front-api/middlewares/ctx";

import message from "./[mId]";

const app = publicApiApp();

app.route("/:mId", message);

export default app;

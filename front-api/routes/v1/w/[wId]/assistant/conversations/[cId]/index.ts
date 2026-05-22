import { publicApiApp } from "@front-api/middlewares/ctx";

import events from "./events";
import messages from "./messages";

// Mounted at /api/v1/w/:wId/assistant/conversations/:cId.
// Carries the SSE `events` and `messages/.../events` redirect stubs;
// remaining conversation routes are still in Next.
const app = publicApiApp();

app.route("/events", events);
app.route("/messages", messages);

export default app;

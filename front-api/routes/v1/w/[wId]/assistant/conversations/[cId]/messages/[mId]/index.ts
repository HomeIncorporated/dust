import { publicApiApp } from "@front-api/middlewares/ctx";

import events from "./events";

// Mounted at /api/v1/w/:wId/assistant/conversations/:cId/messages/:mId.
// Currently only carries the SSE `events` redirect stub; remaining
// `messages/[mId]` routes are still in Next.
const app = publicApiApp();

app.route("/events", events);

export default app;

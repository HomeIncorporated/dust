import { isConversationEventAllowedForAuth } from "@app/lib/api/assistant/conversation";
import { getConversationEvents } from "@app/lib/api/assistant/pubsub";
import { ConversationResource } from "@app/lib/resources/conversation_resource";
import { getStatsDClient } from "@app/lib/utils/statsd";
import logger from "@app/logger/logger";
import { apiErrorForConversation } from "@front-api/lib/api/assistant/conversation/helper";
import { initSSEHeaders } from "@front-api/lib/api/sse";
import { workspaceApp } from "@front-api/middlewares/ctx";
import { streamingTag } from "@front-api/middlewares/streaming";
import { stream } from "hono/streaming";

// Mounted at /api/sse/w/:wId/assistant/conversations/:cId/events.
const app = workspaceApp();

app.get("/", streamingTag, async (ctx) => {
  const auth = ctx.get("auth");
  const conversationId = ctx.req.param("cId") ?? "";

  const conversationRes =
    await ConversationResource.fetchConversationWithoutContent(
      auth,
      conversationId
    );
  if (conversationRes.isErr()) {
    return apiErrorForConversation(ctx, conversationRes.error);
  }
  const conversation = conversationRes.value;

  const lastEventId = ctx.req.query("lastEventId") ?? null;

  initSSEHeaders(ctx);

  return stream(ctx, async (s) => {
    const controller = new AbortController();
    s.onAbort(() => controller.abort());

    let backpressureCount = 0;
    const writeOrCount = async (chunk: string) => {
      try {
        await s.write(chunk);
      } catch {
        backpressureCount++;
        getStatsDClient().increment("streaming.backpressure.count", 1, [
          "endpoint_type:internal",
          "endpoint:conversation_events",
        ]);
      }
    };

    for await (const event of getConversationEvents({
      conversationId: conversation.sId,
      lastEventId,
      signal: controller.signal,
    })) {
      if (s.aborted) {
        break;
      }
      const isAllowed = await isConversationEventAllowedForAuth(auth, {
        event: event.data,
      });
      if (!isAllowed) {
        continue;
      }
      await writeOrCount(`data: ${JSON.stringify(event)}\n\n`);
    }
    await writeOrCount("data: done\n\n");

    if (backpressureCount > 10) {
      logger.warn(
        {
          conversationId: conversation.sId,
          backpressureCount,
          endpointType: "internal",
        },
        "High streaming backpressure detected during conversation events"
      );
    }
  });
});

export default app;

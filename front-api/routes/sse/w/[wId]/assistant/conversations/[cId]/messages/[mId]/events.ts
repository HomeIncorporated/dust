import { getConversationMessageType } from "@app/lib/api/assistant/conversation";
import { getMessagesEvents } from "@app/lib/api/assistant/pubsub";
import { ConversationResource } from "@app/lib/resources/conversation_resource";
import { getStatsDClient } from "@app/lib/utils/statsd";
import logger from "@app/logger/logger";
import { apiErrorForConversation } from "@front-api/lib/api/assistant/conversation/helper";
import { initSSEHeaders } from "@front-api/lib/api/sse";
import { workspaceApp } from "@front-api/middlewares/ctx";
import { streamingTag } from "@front-api/middlewares/streaming";
import { apiError } from "@front-api/middlewares/utils";
import { stream } from "hono/streaming";

// Mounted at /api/sse/w/:wId/assistant/conversations/:cId/messages/:mId/events.
const app = workspaceApp();

app.get("/", streamingTag, async (ctx) => {
  const auth = ctx.get("auth");
  const conversationId = ctx.req.param("cId") ?? "";
  const messageId = ctx.req.param("mId") ?? "";

  const conversationRes =
    await ConversationResource.fetchConversationWithoutContent(
      auth,
      conversationId
    );
  if (conversationRes.isErr()) {
    return apiErrorForConversation(ctx, conversationRes.error);
  }
  const conversation = conversationRes.value;

  const messageType = await getConversationMessageType(
    auth,
    conversation,
    messageId
  );
  if (!messageType) {
    return apiError(ctx, {
      status_code: 404,
      api_error: {
        type: "message_not_found",
        message: "The message you're trying to access was not found.",
      },
    });
  }
  if (messageType !== "agent_message") {
    return apiError(ctx, {
      status_code: 400,
      api_error: {
        type: "invalid_request_error",
        message: "Events are only available for agent messages.",
      },
    });
  }

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
          "endpoint:message_events",
        ]);
      }
    };

    for await (const event of getMessagesEvents(auth, {
      messageId,
      lastEventId,
      signal: controller.signal,
    })) {
      if (s.aborted) {
        break;
      }
      await writeOrCount(`data: ${JSON.stringify(event)}\n\n`);
    }
    await writeOrCount("data: done\n\n");

    if (backpressureCount > 10) {
      logger.warn(
        {
          conversationId: conversation.sId,
          messageId,
          backpressureCount,
          endpointType: "internal",
        },
        "High streaming backpressure detected during message events"
      );
    }
  });
});

export default app;

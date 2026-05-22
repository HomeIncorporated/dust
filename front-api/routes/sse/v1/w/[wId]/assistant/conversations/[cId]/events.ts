import { isConversationEventAllowedForAuth } from "@app/lib/api/assistant/conversation";
import { getConversationEvents } from "@app/lib/api/assistant/pubsub";
import { addBackwardCompatibleAgentMessageFields } from "@app/lib/api/v1/backward_compatibility";
import { ConversationResource } from "@app/lib/resources/conversation_resource";
import { getStatsDClient } from "@app/lib/utils/statsd";
import logger from "@app/logger/logger";
import type { ConversationEventType } from "@dust-tt/client";
import { apiErrorForConversation } from "@front-api/lib/api/assistant/conversation/helper";
import { initSSEHeaders } from "@front-api/lib/api/sse";
import { publicApiApp } from "@front-api/middlewares/ctx";
import { streamingTag } from "@front-api/middlewares/streaming";
import { apiError } from "@front-api/middlewares/utils";
import { stream } from "hono/streaming";

// Mounted at /api/sse/v1/w/:wId/assistant/conversations/:cId/events.
const app = publicApiApp();

app.get("/", streamingTag, async (ctx) => {
  const auth = ctx.get("auth");
  const conversationId = ctx.req.param("cId") ?? "";
  if (!conversationId) {
    return apiError(ctx, {
      status_code: 404,
      api_error: {
        type: "conversation_not_found",
        message: "Conversation not found.",
      },
    });
  }

  const lastEventId = ctx.req.query("lastEventId") ?? null;

  const conversationRes =
    await ConversationResource.fetchConversationWithoutContent(
      auth,
      conversationId
    );
  if (conversationRes.isErr()) {
    return apiErrorForConversation(ctx, conversationRes.error);
  }
  const conversation = conversationRes.value;

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
          "endpoint_type:v1",
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
      // Internal events are not exposed via the public API.
      if (
        event.data.type === "compaction_message_new" ||
        event.data.type === "compaction_message_done" ||
        event.data.type === "plan_updated"
      ) {
        continue;
      }
      const isAllowed = await isConversationEventAllowedForAuth(auth, {
        event: event.data,
      });
      if (!isAllowed) {
        continue;
      }

      const publicEvent: ConversationEventType =
        event.data.type === "agent_message_new"
          ? {
              eventId: event.eventId,
              data: {
                ...event.data,
                message: {
                  ...event.data.message,
                  ...addBackwardCompatibleAgentMessageFields(
                    event.data.message
                  ),
                },
              },
            }
          : { eventId: event.eventId, data: event.data };

      await writeOrCount(`data: ${JSON.stringify(publicEvent)}\n\n`);
    }
    await writeOrCount("data: done\n\n");

    if (backpressureCount > 10) {
      logger.warn(
        {
          conversationId: conversation.sId,
          backpressureCount,
          endpointType: "v1",
        },
        "High streaming backpressure detected during conversation events"
      );
    }
  });
});

export default app;

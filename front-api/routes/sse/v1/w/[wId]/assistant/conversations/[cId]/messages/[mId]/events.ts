import { isRunAgentQueryProgressOutput } from "@app/lib/actions/mcp_internal_actions/output_schemas";
import type { ActionGeneratedDBFileType } from "@app/lib/actions/types";
import { getConversationMessageType } from "@app/lib/api/assistant/conversation";
import { getMessagesEvents } from "@app/lib/api/assistant/pubsub";
import config from "@app/lib/api/config";
import { ConversationResource } from "@app/lib/resources/conversation_resource";
import { getStatsDClient } from "@app/lib/utils/statsd";
import logger from "@app/logger/logger";
import type { AgentMessageEventType } from "@dust-tt/client";
import { apiErrorForConversation } from "@front-api/lib/api/assistant/conversation/helper";
import { initSSEHeaders } from "@front-api/lib/api/sse";
import { publicApiApp } from "@front-api/middlewares/ctx";
import { streamingTag } from "@front-api/middlewares/streaming";
import { apiError } from "@front-api/middlewares/utils";
import { stream } from "hono/streaming";

// Mounted at /api/sse/v1/w/:wId/assistant/conversations/:cId/messages/:mId/events.
const app = publicApiApp();

app.get("/", streamingTag, async (ctx) => {
  const auth = ctx.get("auth");
  const conversationId = ctx.req.param("cId") ?? "";
  const messageId = ctx.req.param("mId") ?? "";
  if (!conversationId) {
    return apiError(ctx, {
      status_code: 404,
      api_error: {
        type: "conversation_not_found",
        message: "Conversation not found.",
      },
    });
  }
  if (!messageId) {
    return apiError(ctx, {
      status_code: 404,
      api_error: {
        type: "message_not_found",
        message: "Message not found.",
      },
    });
  }

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
          "endpoint_type:v1",
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

      let publicEvent: AgentMessageEventType;
      if (event.data.type === "tool_notification") {
        const { label, output: originalOutput } =
          event.data.notification._meta.data;
        let output;
        if (isRunAgentQueryProgressOutput(originalOutput)) {
          const wId = auth.getNonNullableWorkspace().sId;
          const { conversationId: subConversationId, agentMessageId } =
            originalOutput;
          const childConversationUrl = `${config.getApiBaseUrl()}/api/v1/w/${wId}/assistant/conversations/${subConversationId}`;
          output = {
            ...originalOutput,
            childConversationUrl,
            childConversationEventsUrl: agentMessageId
              ? `${childConversationUrl}/messages/${agentMessageId}/events`
              : null,
          };
        } else {
          output = originalOutput;
        }
        publicEvent = {
          eventId: event.eventId,
          data: {
            ...event.data,
            action: {
              ...event.data.action,
              generatedFiles: event.data.action.generatedFiles.filter(
                (f): f is ActionGeneratedDBFileType => f.fileId !== null
              ),
            },
            notification: {
              ...event.data.notification,
              // For backward compatibility, move _meta.data to root level.
              data: { label, output },
            },
          },
        };
      } else if (
        event.data.type === "agent_action_success" ||
        event.data.type === "tool_params"
      ) {
        publicEvent = {
          eventId: event.eventId,
          data: {
            ...event.data,
            action: {
              ...event.data.action,
              generatedFiles: event.data.action.generatedFiles.filter(
                (f): f is ActionGeneratedDBFileType => f.fileId !== null
              ),
            },
          },
        };
      } else {
        publicEvent = { eventId: event.eventId, data: event.data };
      }

      await writeOrCount(`data: ${JSON.stringify(publicEvent)}\n\n`);
    }

    if (backpressureCount > 10) {
      logger.warn(
        {
          conversationId: conversation.sId,
          messageId,
          backpressureCount,
          endpointType: "v1",
        },
        "High streaming backpressure detected during message events"
      );
    }
  });
});

export default app;

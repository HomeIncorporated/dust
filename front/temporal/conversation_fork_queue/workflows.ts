import type { AuthenticatorType } from "@app/lib/auth";
import type * as activities from "@app/temporal/conversation_fork_queue/activities";
import type { CompactionSourceConversation } from "@app/types/assistant/compaction";
import type { SupportedModel } from "@app/types/assistant/models/types";
import { normalizeError } from "@app/types/shared/utils/error_utils";
import { proxyActivities } from "@temporalio/workflow";

const { copyConversationGCSMountActivity } = proxyActivities<typeof activities>(
  {
    startToCloseTimeout: "10 minutes",
    retry: {
      maximumAttempts: 3,
      initialInterval: "5s",
      backoffCoefficient: 2,
      maximumInterval: "1m",
    },
  }
);

const { failCompactionMessageActivity } = proxyActivities<typeof activities>({
  startToCloseTimeout: "30 seconds",
  retry: {
    maximumAttempts: 10,
    initialInterval: "1s",
    backoffCoefficient: 2,
    maximumInterval: "30s",
  },
});

const { generateForkCompactionActivity } = proxyActivities<typeof activities>({
  startToCloseTimeout: "10 minutes",
  retry: {
    // Do not retry: the LLM call is not idempotent and the message is marked failed on error.
    maximumAttempts: 1,
  },
});

const { finalizeCompactionActivity } = proxyActivities<typeof activities>({
  startToCloseTimeout: "30 seconds",
  retry: {
    maximumAttempts: 3,
    initialInterval: "1s",
    backoffCoefficient: 2,
    maximumInterval: "30s",
  },
});

export async function conversationForkWorkflow({
  workspaceId,
  sourceConversationId,
  destConversationId,
  authType,
  compactionMessageId,
  compactionMessageVersion,
  model,
  sourceConversation,
}: {
  workspaceId: string;
  sourceConversationId: string;
  destConversationId: string;
  authType: AuthenticatorType;
  compactionMessageId: string;
  compactionMessageVersion: number;
  model: SupportedModel;
  sourceConversation: CompactionSourceConversation;
}): Promise<void> {
  try {
    const [, forkCompactionResult] = await Promise.all([
      copyConversationGCSMountActivity({
        workspaceId,
        sourceConversationId,
        destConversationId,
      }),
      generateForkCompactionActivity(authType, {
        conversationId: destConversationId,
        compactionMessageId,
        compactionMessageVersion,
        model,
        sourceConversation,
      }),
    ]);
    await finalizeCompactionActivity(authType, {
      conversationId: destConversationId,
      compactionMessageId,
      compactionMessageVersion,
      status: forkCompactionResult.status,
    });
  } catch (err) {
    await failCompactionMessageActivity({
      workspaceId,
      conversationId: destConversationId,
      compactionMessageId,
      compactionMessageVersion,
    });

    throw normalizeError(err);
  }
}

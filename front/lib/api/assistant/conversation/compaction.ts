import {
  getConversationRankVersionLock,
  getNextConversationMessageRank,
} from "@app/lib/api/assistant/conversation/lock";
import { createCompactionMessage } from "@app/lib/api/assistant/conversation/messages";
import { publishConversationEvent } from "@app/lib/api/assistant/streaming/events";
import { Authenticator } from "@app/lib/auth";
import {
  AgentMessageModel,
  CompactionMessageModel,
  MessageModel,
} from "@app/lib/models/agent/conversation";
import { SkillResource } from "@app/lib/resources/skill/skill_resource";
import { withTransaction } from "@app/lib/utils/sql_utils";
import { launchCompactionWorkflow } from "@app/temporal/agent_loop/client";
import type { CompactionSourceConversation } from "@app/types/assistant/compaction";
import type {
  AgentMessageType,
  CompactionMessageType,
  ConversationType,
  ConversationWithoutContentType,
} from "@app/types/assistant/conversation";
import {
  isAgentMessageType,
  isCompactionMessageType,
} from "@app/types/assistant/conversation";
import type { SupportedModel } from "@app/types/assistant/models/types";
import type { APIErrorWithStatusCode } from "@app/types/error";
import type { Result } from "@app/types/shared/result";
import { Err, Ok } from "@app/types/shared/result";

async function createAndPublishCompactionMessage(
  auth: Authenticator,
  {
    conversation,
    sourceConversation,
  }: {
    conversation: ConversationType;
    sourceConversation?: CompactionSourceConversation;
  }
): Promise<
  Result<{ compactionMessage: CompactionMessageType }, APIErrorWithStatusCode>
> {
  const owner = auth.getNonNullableWorkspace();

  // Block compaction while an agent message is running or a compaction is running.
  const runningAgentMessage = conversation.content
    .flat()
    .find(
      (m): m is AgentMessageType =>
        isAgentMessageType(m) && m.status === "created"
    );
  const runningCompaction = conversation.content
    .flat()
    .find(
      (m): m is CompactionMessageType =>
        isCompactionMessageType(m) && m.status === "created"
    );
  const lastMessage = conversation.content.at(-1)?.at(-1);

  if (runningAgentMessage) {
    return new Err({
      status_code: 409,
      api_error: {
        type: "invalid_request_error",
        message: "Answer the pending agent message first.",
      },
    });
  }

  if (runningCompaction) {
    return new Err({
      status_code: 409,
      api_error: {
        type: "invalid_request_error",
        message: "A compaction is already in progress. Please wait.",
      },
    });
  }

  if (lastMessage && isCompactionMessageType(lastMessage)) {
    return new Err({
      status_code: 409,
      api_error: {
        type: "invalid_request_error",
        message:
          "This conversation was just compacted. Send a new message before compacting again.",
      },
    });
  }

  const { compactionMessage } = await withTransaction(async (t) => {
    await getConversationRankVersionLock(auth, conversation, t);

    // Re-check the existence of a compaction message or running agent message inside the critical
    // section of the advisory lock to avoid stacking compaction with other compaction or running
    // agent loop.
    const [runningCompactionMessage, runningAgentMessage] = await Promise.all([
      MessageModel.findOne({
        where: {
          conversationId: conversation.id,
          workspaceId: owner.id,
        },
        include: [
          {
            model: CompactionMessageModel,
            as: "compactionMessage",
            required: true,
            where: { status: "created" },
          },
        ],
        transaction: t,
      }),
      MessageModel.findOne({
        where: {
          conversationId: conversation.id,
          workspaceId: owner.id,
        },
        include: [
          {
            model: AgentMessageModel,
            as: "agentMessage",
            required: true,
            where: { status: "created" },
          },
        ],
        transaction: t,
      }),
    ]);

    if (runningCompactionMessage || runningAgentMessage) {
      return { compactionMessage: null };
    }

    const nextMessageRank = await getNextConversationMessageRank(auth, {
      conversation,
      transaction: t,
    });

    const compactionMessage = await createCompactionMessage(auth, {
      conversation,
      rank: nextMessageRank,
      sourceConversationId:
        sourceConversation?.conversationId &&
        sourceConversation.conversationId !== conversation.sId
          ? sourceConversation.conversationId
          : undefined,
      transaction: t,
    });

    return { compactionMessage };
  });

  if (!compactionMessage) {
    return new Err({
      status_code: 409,
      api_error: {
        type: "invalid_request_error",
        message:
          "Cannot compact while another compaction or an agent message is running.",
      },
    });
  }

  await publishConversationEvent(
    {
      type: "compaction_message_new",
      created: Date.now(),
      messageId: compactionMessage.sId,
      message: compactionMessage,
    },
    { conversationId: conversation.sId }
  );

  return new Ok({ compactionMessage });
}

// Creates the CompactionMessage (blocks posting) without launching the compaction workflow.
// Use this when the caller's own Temporal workflow will run compaction — e.g. the fork workflow
// runs GCS copy then compaction sequentially, so the block must be set up before the fork
// workflow starts and released only after both steps complete.
export async function initCompactionForFork(
  auth: Authenticator,
  {
    conversation,
    sourceConversation,
  }: {
    conversation: ConversationType;
    sourceConversation?: CompactionSourceConversation;
  }
): Promise<
  Result<{ compactionMessage: CompactionMessageType }, APIErrorWithStatusCode>
> {
  return createAndPublishCompactionMessage(auth, {
    conversation,
    sourceConversation,
  });
}

export async function compactConversation(
  auth: Authenticator,
  {
    conversation,
    model,
    sourceConversation,
  }: {
    conversation: ConversationType;
    model: SupportedModel;
    sourceConversation?: CompactionSourceConversation;
  }
): Promise<
  Result<{ compactionMessage: CompactionMessageType }, APIErrorWithStatusCode>
> {
  const result = await createAndPublishCompactionMessage(auth, {
    conversation,
    sourceConversation,
  });
  if (result.isErr()) {
    return result;
  }
  void launchCompactionWorkflow({
    auth,
    conversationId: conversation.sId,
    compactionMessageId: result.value.compactionMessage.sId,
    compactionMessageVersion: result.value.compactionMessage.version,
    model,
    sourceConversation,
  });
  return result;
}

export async function setCompactionMessageContent(
  auth: Authenticator,
  {
    compactionMessage,
    content,
  }: {
    compactionMessage: CompactionMessageType;
    content: string;
  }
): Promise<void> {
  const owner = auth.getNonNullableWorkspace();
  await CompactionMessageModel.update(
    { content },
    {
      where: {
        id: compactionMessage.compactionMessageId,
        workspaceId: owner.id,
      },
    }
  );
}

export async function updateCompactionMessageWithContentAndFinalStatus(
  auth: Authenticator,
  {
    conversation,
    compactionMessage,
    clearEnabledSkillsOnSuccess,
    status,
    content,
  }: {
    conversation: ConversationWithoutContentType;
    compactionMessage: CompactionMessageType;
    clearEnabledSkillsOnSuccess: boolean;
    status: "succeeded" | "failed";
    content: string | null;
  }
): Promise<{
  completedTs: number;
  status: "succeeded" | "failed";
}> {
  const completedAt = new Date();
  const owner = auth.getNonNullableWorkspace();

  await withTransaction(async (t) => {
    await getConversationRankVersionLock(auth, conversation, t);

    await CompactionMessageModel.update(
      { status, content },
      {
        where: {
          id: compactionMessage.compactionMessageId,
          workspaceId: owner.id,
        },
        transaction: t,
      }
    );

    if (status === "succeeded" && clearEnabledSkillsOnSuccess) {
      await SkillResource.clearAllEnabledByConversation(
        auth,
        {
          conversation,
        },
        { transaction: t }
      );
    }
  });

  return {
    completedTs: completedAt.getTime(),
    status,
  };
}

// Fork-specific: content was already stored by setCompactionMessageContent in Phase 1.
export async function updateCompactionMessageWithFinalStatus(
  auth: Authenticator,
  {
    conversation,
    compactionMessage,
    clearEnabledSkillsOnSuccess,
    status,
  }: {
    conversation: ConversationWithoutContentType;
    compactionMessage: CompactionMessageType;
    clearEnabledSkillsOnSuccess: boolean;
    status: "succeeded" | "failed";
  }
): Promise<{
  completedTs: number;
  status: "succeeded" | "failed";
}> {
  const completedAt = new Date();
  const owner = auth.getNonNullableWorkspace();

  await withTransaction(async (t) => {
    await getConversationRankVersionLock(auth, conversation, t);

    await CompactionMessageModel.update(
      { status },
      {
        where: {
          id: compactionMessage.compactionMessageId,
          workspaceId: owner.id,
        },
        transaction: t,
      }
    );

    if (status === "succeeded" && clearEnabledSkillsOnSuccess) {
      await SkillResource.clearAllEnabledByConversation(
        auth,
        {
          conversation,
        },
        { transaction: t }
      );
    }
  });

  return {
    completedTs: completedAt.getTime(),
    status,
  };
}

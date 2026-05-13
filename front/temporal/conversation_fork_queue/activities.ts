import {
  setCompactionMessageContent,
  updateCompactionMessageWithFinalStatus,
} from "@app/lib/api/assistant/conversation/compaction";
import { getConversation } from "@app/lib/api/assistant/conversation/fetch";
import { copyConversationGCSMount } from "@app/lib/api/files/gcs_mount/files";
import { Authenticator, type AuthenticatorType } from "@app/lib/auth";
import { ConversationResource } from "@app/lib/resources/conversation_resource";
import logger from "@app/logger/logger";
import {
  applyForkCompactionResult,
  computeCompactionContent,
} from "@app/temporal/agent_loop/lib/compaction";
import type { CompactionSourceConversation } from "@app/types/assistant/compaction";
import { isCompactionMessageType } from "@app/types/assistant/conversation";
import type { SupportedModel } from "@app/types/assistant/models/types";

export async function failCompactionMessageActivity({
  workspaceId,
  conversationId,
  compactionMessageId,
  compactionMessageVersion,
}: {
  workspaceId: string;
  conversationId: string;
  compactionMessageId: string;
  compactionMessageVersion: number;
}): Promise<void> {
  const auth = await Authenticator.internalAdminForWorkspace(workspaceId);

  const conversationRes = await getConversation(auth, conversationId);
  if (conversationRes.isErr()) {
    logger.warn(
      { workspaceId, conversationId, compactionMessageId },
      "[conversation_fork_queue] Could not load conversation to fail compaction message."
    );
    return;
  }

  const conversation = conversationRes.value;
  const compactionMessage = conversation.content
    .flat()
    .findLast(
      (m) =>
        isCompactionMessageType(m) &&
        m.sId === compactionMessageId &&
        m.version === compactionMessageVersion
    );

  if (!compactionMessage || !isCompactionMessageType(compactionMessage)) {
    logger.warn(
      { workspaceId, conversationId, compactionMessageId },
      "[conversation_fork_queue] Compaction message not found; cannot mark as failed."
    );
    return;
  }

  if (compactionMessage.status !== "created") {
    return;
  }

  await updateCompactionMessageWithFinalStatus(auth, {
    conversation,
    compactionMessage,
    clearEnabledSkillsOnSuccess: false,
    status: "failed",
  });
}

export async function copyConversationGCSMountActivity({
  workspaceId,
  sourceConversationId,
  destConversationId,
}: {
  workspaceId: string;
  sourceConversationId: string;
  destConversationId: string;
}): Promise<void> {
  const auth = await Authenticator.internalAdminForWorkspace(workspaceId);

  const [source, dest] = await Promise.all([
    ConversationResource.fetchById(auth, sourceConversationId),
    ConversationResource.fetchById(auth, destConversationId),
  ]);

  if (!source || !dest) {
    logger.error(
      {
        workspaceId,
        sourceConversationId,
        destConversationId,
        sourceFound: !!source,
        destFound: !!dest,
      },
      "[conversation_fork_queue] Source or destination conversation not found for GCS mount copy."
    );

    throw new Error(
      "Source or destination conversation not found for GCS mount copy."
    );
  }

  const result = await copyConversationGCSMount(auth, { source, dest });
  if (result.isErr()) {
    throw result.error;
  }

  logger.info(
    {
      workspaceId,
      sourceConversationId,
      destConversationId,
      copiedCount: result.value.copiedCount,
    },
    "[conversation_fork_queue] Copied GCS mount files between conversations."
  );
}

export async function generateForkCompactionActivity(
  authType: AuthenticatorType,
  {
    conversationId,
    compactionMessageId,
    compactionMessageVersion,
    model,
    sourceConversation,
  }: {
    conversationId: string;
    compactionMessageId: string;
    compactionMessageVersion: number;
    model: SupportedModel;
    sourceConversation?: CompactionSourceConversation;
  }
): Promise<{ status: "succeeded" | "failed" }> {
  const authResult = await Authenticator.fromJSON(authType);
  if (authResult.isErr()) {
    throw new Error(
      `Failed to deserialize authenticator: ${authResult.error.code}`
    );
  }
  const auth = authResult.value;

  const contentRes = await computeCompactionContent(auth, {
    conversationId,
    compactionMessageId,
    compactionMessageVersion,
    model,
    sourceConversation,
  });

  if (contentRes.isErr()) {
    throw new Error(
      `Fork compaction content generation failed: ${contentRes.error.message}`
    );
  }

  const { content, status } = contentRes.value;

  if (content !== null) {
    // Persist content to DB so it doesn't need to flow through Temporal workflow state.
    // finalizeCompactionActivity will read it back from the conversation fetch.
    const conversationRes = await getConversation(auth, conversationId);
    if (conversationRes.isErr()) {
      throw new Error(
        `Fork compaction: failed to reload conversation for content persistence: ${conversationRes.error.message}`
      );
    }

    const compactionMessage = conversationRes.value.content
      .flat()
      .findLast(
        (m) =>
          isCompactionMessageType(m) &&
          m.sId === compactionMessageId &&
          m.version === compactionMessageVersion
      );

    if (!compactionMessage || !isCompactionMessageType(compactionMessage)) {
      throw new Error(
        `Fork compaction: compaction message not found for content persistence: ${compactionMessageId}`
      );
    }

    await setCompactionMessageContent(auth, { compactionMessage, content });
  }

  return { status };
}

export async function finalizeCompactionActivity(
  authType: AuthenticatorType,
  {
    conversationId,
    compactionMessageId,
    compactionMessageVersion,
    status,
  }: {
    conversationId: string;
    compactionMessageId: string;
    compactionMessageVersion: number;
    status: "succeeded" | "failed";
  }
): Promise<void> {
  const authResult = await Authenticator.fromJSON(authType);
  if (authResult.isErr()) {
    throw new Error(
      `Failed to deserialize authenticator: ${authResult.error.code}`
    );
  }
  const auth = authResult.value;

  const applyRes = await applyForkCompactionResult(auth, {
    conversationId,
    compactionMessageId,
    compactionMessageVersion,
    status,
  });

  if (applyRes.isErr()) {
    throw new Error(
      `Fork compaction finalization failed: ${applyRes.error.message}`
    );
  }
}

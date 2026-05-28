import { getNovuClient } from "@app/lib/notifications/novu-client";
import logger from "@app/logger/logger";
import {
  USER_AWU_CAP_REACHED_TAG,
  USER_AWU_CAP_REACHED_TRIGGER_ID,
} from "@app/types/notification_preferences";
import { workflow } from "@novu/framework";
import z from "zod";

const UserAwuCapReachedPayloadSchema = z.object({
  workspaceId: z.string(),
  workspaceName: z.string(),
  capAwuCredits: z.number(),
});

type UserAwuCapReachedPayloadType = z.infer<
  typeof UserAwuCapReachedPayloadSchema
>;

export const userAwuCapReachedWorkflow = workflow(
  USER_AWU_CAP_REACHED_TRIGGER_ID,
  async ({ step, payload }) => {
    await step.inApp("user-awu-cap-reached-in-app", async () => {
      return {
        subject: "You've reached your usage limit",
        body: `You have reached your ${payload.capAwuCredits} AWU limit in workspace "${payload.workspaceName}". Contact your admin to increase your limit.`,
        data: {
          workspaceId: payload.workspaceId,
          capAwuCredits: payload.capAwuCredits,
        },
      };
    });
  },
  {
    payloadSchema: UserAwuCapReachedPayloadSchema,
    tags: [USER_AWU_CAP_REACHED_TAG],
  }
);

/**
 * Send an in-app Novu notification to a specific user that their AWU cap was
 * reached. Fire-and-forget — errors are logged but don't block the caller.
 */
export function notifyUserAwuCapReached({
  userSId,
  userEmail,
  userFirstName,
  userLastName,
  workspaceId,
  workspaceName,
  capAwuCredits,
}: {
  userSId: string;
  userEmail: string;
  userFirstName: string | null;
  userLastName: string | null;
  workspaceId: string;
  workspaceName: string;
  capAwuCredits: number;
}): void {
  const payload: UserAwuCapReachedPayloadType = {
    workspaceId,
    workspaceName,
    capAwuCredits,
  };

  void getNovuClient()
    .then((novuClient) =>
      novuClient.triggerBulk({
        events: [
          {
            workflowId: USER_AWU_CAP_REACHED_TRIGGER_ID,
            to: {
              subscriberId: userSId,
              email: userEmail,
              firstName: userFirstName ?? undefined,
              lastName: userLastName ?? undefined,
            },
            payload,
          },
        ],
      })
    )
    .then((r) => {
      if (r.result.some((res) => !!res.error?.length)) {
        logger.error(
          { workspaceId, userSId, capAwuCredits },
          "Failed to trigger user AWU cap reached notification"
        );
      }
    })
    .catch((err) => {
      logger.error(
        { err, workspaceId, userSId, capAwuCredits },
        "Failed to trigger user AWU cap reached notification"
      );
    });
}

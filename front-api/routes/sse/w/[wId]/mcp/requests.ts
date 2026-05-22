import { validateMCPServerAccess } from "@app/lib/api/actions/mcp/client_side_registry";
import { getMCPEventsForServer } from "@app/lib/api/assistant/mcp_events";
import { initSSEHeaders } from "@front-api/lib/api/sse";
import { workspaceApp } from "@front-api/middlewares/ctx";
import { streamingTag } from "@front-api/middlewares/streaming";
import { apiError } from "@front-api/middlewares/utils";
import { validate } from "@front-api/middlewares/validator";
import { stream } from "hono/streaming";
import { z } from "zod";

const GetMCPRequestsQuerySchema = z.object({
  serverId: z.string(),
  lastEventId: z.string().optional(),
});

// Mounted at /api/sse/w/:wId/mcp/requests.
const app = workspaceApp();

app.get(
  "/",
  streamingTag,
  validate("query", GetMCPRequestsQuerySchema),
  async (ctx) => {
    const auth = ctx.get("auth");
    const { serverId, lastEventId } = ctx.req.valid("query");

    const isValidAccess = await validateMCPServerAccess(auth, { serverId });
    if (!isValidAccess) {
      return apiError(ctx, {
        status_code: 403,
        api_error: {
          type: "mcp_auth_error",
          message:
            "You don't have access to this MCP server or it has expired.",
        },
      });
    }

    initSSEHeaders(ctx);

    return stream(ctx, async (s) => {
      const controller = new AbortController();
      s.onAbort(() => controller.abort());

      for await (const event of getMCPEventsForServer(
        auth,
        { mcpServerId: serverId, lastEventId },
        controller.signal
      )) {
        if (s.aborted) {
          break;
        }
        await s.write(`data: ${JSON.stringify(event)}\n\n`);
      }
      await s.write("data: done\n\n");
    });
  }
);

export default app;

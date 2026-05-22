import type { Context } from "hono";

/**
 * Initialize SSE (Server-Sent Events) headers on a Hono context.
 *
 * Hono mirror of `initSSEResponse` in `front/lib/api/sse.ts`. The two
 * non-obvious headers:
 *   - `Content-Encoding: none` prevents Node/middleware from wrapping the
 *     response in a Gzip stream (which buffers data, defeating SSE's
 *     real-time purpose, and leaks ~285 KB of native zlib memory per
 *     connection).
 *   - `X-Accel-Buffering: no` tells nginx/reverse proxies not to buffer.
 */
export function initSSEHeaders(ctx: Context): void {
  ctx.header("Content-Type", "text/event-stream");
  ctx.header("Cache-Control", "no-cache");
  ctx.header("Connection", "keep-alive");
  ctx.header("X-Accel-Buffering", "no");
  ctx.header("Content-Encoding", "none");
}

/**
 * sparkshell-fork-worker.ts — IPC worker for direction C.
 *
 * This module is forked by sparkshell-fork.ts. It:
 * 1. Listens for one IPC message: { event, payload }
 * 2. Fires the hooks via the existing runtime (same as `omcp hook fire`)
 * 3. Sends the result back over IPC
 * 4. Exits with code 0 on success, 1 on error
 *
 * The worker is a standalone module — not imported anywhere in production
 * code — it only runs when forked.
 */

import { fireHooks } from "../hooks/runtime.js";

process.on(
  "message",
  (msg: unknown) => {
    void handleMessage(msg);
  },
);

async function handleMessage(msg: unknown): Promise<void> {
  try {
    if (
      typeof msg !== "object" ||
      msg === null ||
      typeof (msg as Record<string, unknown>).event !== "string"
    ) {
      process.send!({ kind: "error", message: "invalid IPC message shape" });
      process.exit(1);
      return;
    }

    const { event, payload } = msg as {
      event: string;
      payload: Record<string, unknown>;
    };

    const cwd =
      typeof payload.cwd === "string" ? payload.cwd : process.cwd();

    const sessionId =
      typeof payload.sessionId === "string"
        ? payload.sessionId
        : typeof payload.session_id === "string"
          ? payload.session_id
          : "";

    const entries = await fireHooks(event as Parameters<typeof fireHooks>[0], {
      sessionId,
      cwd,
      payload,
    });

    process.send!({ kind: "ok", entries });
    process.exit(0);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    process.send!({ kind: "error", message });
    process.exit(1);
  }
}

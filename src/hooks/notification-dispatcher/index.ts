/**
 * Notification Dispatcher Hook
 *
 * Wires Copilot's Notification events to the background notification
 * dispatcher and appends an audit line to `.omcp/state/notifications.jsonl`.
 *
 * Subscribes to: Notification
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { Hook, HookContext, HookResult } from "../hook-types.js";
import { dispatchNotificationInBackground } from "../background-notifications.js";
import type { BackgroundNotificationData } from "../background-notifications.js";

/** Path to notifications.jsonl audit log. */
export function notificationsFilePath(cwd: string): string {
  return path.join(cwd, ".omcp", "state", "notifications.jsonl");
}

export interface NotificationRecord {
  ts: string;
  sessionId: string;
  payload: unknown;
}

/**
 * Append a notification record to the audit log.
 * Creates the parent directory if needed.
 */
export function appendNotificationRecord(
  cwd: string,
  record: NotificationRecord,
): void {
  const filePath = notificationsFilePath(cwd);
  const dir = path.dirname(filePath);
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.appendFileSync(filePath, JSON.stringify(record) + "\n", "utf-8");
  } catch {
    // Best-effort — audit logging must never crash the hook
  }
}

/**
 * Create the notification-dispatcher Hook object.
 *
 * Subscribes to Notification.
 * Dispatches to background-notifications and logs to notifications.jsonl.
 * Returns `{ kind: "noop" }` — observational only.
 */
export function createNotificationDispatcherHook(): Hook {
  return {
    name: "notification-dispatcher",
    events: ["Notification"],

    async run(ctx: HookContext): Promise<HookResult> {
      const payload = ctx.toolArgs;

      // Append audit record first — must succeed even if dispatch fails
      appendNotificationRecord(ctx.cwd, {
        ts: new Date().toISOString(),
        sessionId: ctx.sessionId,
        payload: payload ?? null,
      });

      // Dispatch to background notifications — best-effort
      try {
        const data: BackgroundNotificationData = {
          sessionId: ctx.sessionId,
          ...(typeof payload === "object" && payload !== null
            ? (payload as Partial<BackgroundNotificationData>)
            : {}),
        };
        dispatchNotificationInBackground("session-continuing", data);
      } catch {
        // Dispatch failure must not crash the hook — already logged above
      }

      return { kind: "noop" };
    },
  };
}

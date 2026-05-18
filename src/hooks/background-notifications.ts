// Detached child-process notification dispatcher.
//
// Hook foreground processes have a strict stdout JSON protocol, and some CI
// checks fail on unexpected stderr. Running notification work in-process would
// let late console output from notification formatters, transport failures,
// custom integrations, or transitive modules pollute the foreground hook
// streams. The detached child uses stdio: "ignore" so all notification
// stdout/stderr is isolated while the foreground hook can return its protocol
// payload promptly.
//
// Adapted from omc 4.14.0 — omcp uses a different notification shape:
//   - omc: notify(event, data) — single facade reads config internally
//   - omcp: dispatch(event, ctx, config, options) — caller loads config
// So the child snippet loads config via the omcp config-loader before
// dispatching. If config loading or dispatch throws inside the child, errors
// are swallowed (notification dispatch must never break hook handling).
//
// Detached-spawn semantics:
//   - POSIX: detached:true puts the child in a new process group so the parent
//     can exit without sending SIGHUP. child.unref() removes it from the event
//     loop reference count so the parent can exit immediately.
//   - Windows: detached:true creates a new console window normally; we pair it
//     with windowsHide:true to suppress that console. There is no process
//     group concept on Windows, but unref() still detaches the IPC handle so
//     the parent exits cleanly.
//   - stdio:"ignore" closes the child's stdin/stdout/stderr so the parent
//     hook stdout pipe stays a clean JSON channel.

import { spawn } from "node:child_process";
import type { NotifyContext, NotifyEvent } from "../notifications/types.js";

export type BackgroundNotificationData = Partial<NotifyContext> & {
  sessionId: string;
  profileName?: string;
};

/**
 * Dispatch a hook-triggered notification from an isolated detached Node
 * process. Returns immediately; never throws.
 *
 * Set `OMCP_NOTIFY=0` to disable. The child process inherits the parent
 * environment plus `OMCP_HOOK_BACKGROUND_CHILD=1` so notification platforms
 * can detect they are running detached (useful for tests, telemetry, or
 * platforms that want to skip foreground-only behavior).
 */
export function dispatchNotificationInBackground(
  event: NotifyEvent,
  data: BackgroundNotificationData,
): void {
  if (process.env.OMCP_NOTIFY === "0") return;

  let serializedEvent: string;
  let serializedData: string;
  try {
    serializedEvent = JSON.stringify(event);
    serializedData = JSON.stringify(data);
  } catch {
    // Unserializable input — best-effort dispatch, abort silently.
    return;
  }

  // The child source resolves the omcp notifications entry by walking from
  // this file's URL. After build the layout is:
  //   dist/hooks/background-notifications.js
  //   dist/notifications/dispatcher.js
  //   dist/notifications/config-loader.js
  // so the relative URL "../notifications/..." holds in both src and dist.
  const dispatcherModuleUrl = new URL(
    "../notifications/dispatcher.js",
    import.meta.url,
  ).href;
  const configLoaderModuleUrl = new URL(
    "../notifications/config-loader.js",
    import.meta.url,
  ).href;

  const childSource =
    `Promise.all([\n` +
    `  import(${JSON.stringify(dispatcherModuleUrl)}),\n` +
    `  import(${JSON.stringify(configLoaderModuleUrl)})\n` +
    `]).then(([d, c]) => {\n` +
    `  const config = c.loadConfig();\n` +
    `  if (!config.notifications && !config.customIntegrations) return;\n` +
    `  return d.dispatch(${serializedEvent}, ${serializedData}, config);\n` +
    `}).catch(() => {});`;

  try {
    const child = spawn(
      process.execPath,
      ["--input-type=module", "-e", childSource],
      {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env: {
          ...process.env,
          OMCP_HOOK_BACKGROUND_CHILD: "1",
        },
      },
    );
    child.unref();
  } catch {
    // Best-effort only: notification dispatch must never break hook handling.
  }
}

// Reference PostToolUse hook bundled with the plugin install.
// Self-contained — no imports from ../src/ or ../dist/, so the file resolves
// cleanly inside ~/.copilot/installed-plugins/oh-my-copilot/oh-my-copilot/hooks/.
//
// Surfaces tool-completion notifications via the omcp notification dispatcher
// in a detached child process, so the foreground hook stdout stream stays a
// clean JSON channel. Only emits when:
//   1. OMCP_NOTIFY is not "0"
//   2. The omcp dist tree is locatable from one of the standard install roots
//   3. The user has at least one notifications.* platform configured
//
// All work is best-effort — failures are swallowed.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

type HookEvent =
  | "PreToolUse"
  | "PostToolUse"
  | "PreSubmit"
  | "PostSubmit"
  | "SessionStart"
  | "PreEnd";

interface HookContext {
  event: HookEvent;
  toolName?: string;
  toolArgs?: unknown;
  toolResult?: unknown;
  sessionId: string;
  cwd: string;
}

type HookResult =
  | { kind: "noop" }
  | { kind: "advise"; text: string }
  | { kind: "block"; reason: string };

interface Hook {
  name: string;
  events: HookEvent[];
  run(ctx: HookContext): Promise<HookResult>;
}

function locateOmcpDistRoot(): string | null {
  const candidates: string[] = [];
  if (process.env.OMCP_DIST_ROOT) candidates.push(process.env.OMCP_DIST_ROOT);
  if (process.env.OMCP_PLUGIN_ROOT)
    candidates.push(join(process.env.OMCP_PLUGIN_ROOT, "dist"));
  candidates.push(
    join(
      homedir(),
      ".copilot",
      "installed-plugins",
      "oh-my-copilot",
      "oh-my-copilot",
      "dist",
    ),
  );
  for (const root of candidates) {
    const dispatcher = join(root, "notifications", "dispatcher.js");
    const loader = join(root, "notifications", "config-loader.js");
    if (existsSync(dispatcher) && existsSync(loader)) return root;
  }
  return null;
}

export const backgroundNotifyHook: Hook = {
  name: "post-tool-background-notify",
  events: ["PostToolUse"],
  async run(ctx: HookContext): Promise<HookResult> {
    if (process.env.OMCP_NOTIFY === "0") return { kind: "noop" };
    if (process.env.OMCP_HOOK_BACKGROUND_CHILD === "1")
      return { kind: "noop" };

    const distRoot = locateOmcpDistRoot();
    if (!distRoot) return { kind: "noop" };

    const dispatcherUrl = pathToFileURL(
      join(distRoot, "notifications", "dispatcher.js"),
    ).href;
    const loaderUrl = pathToFileURL(
      join(distRoot, "notifications", "config-loader.js"),
    ).href;

    let serializedData: string;
    try {
      serializedData = JSON.stringify({
        sessionId: ctx.sessionId,
        projectPath: ctx.cwd,
        projectName: ctx.cwd.split(/[\\/]/).pop() ?? "",
        timestamp: new Date().toISOString(),
        toolName: ctx.toolName,
      });
    } catch {
      return { kind: "noop" };
    }

    const childSource =
      `Promise.all([\n` +
      `  import(${JSON.stringify(dispatcherUrl)}),\n` +
      `  import(${JSON.stringify(loaderUrl)})\n` +
      `]).then(([d, c]) => {\n` +
      `  const config = c.loadConfig();\n` +
      `  if (!config.notifications && !config.customIntegrations) return;\n` +
      `  return d.dispatch("session-continuing", ${serializedData}, config);\n` +
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
      // best-effort
    }
    return { kind: "noop" };
  },
};

export default backgroundNotifyHook;
export const hook = backgroundNotifyHook;

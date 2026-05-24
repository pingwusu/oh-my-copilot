import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  mergeCopilotHooks,
  resolveDefaultOmcpBin,
  resolveHookCommandBin,
  resolveHookDispatchCommand,
} from "../runtime/copilot-config.js";

// path.join uses the host platform's separator. Tests assert against the
// host-resolved join so they pass on both Windows and POSIX runners.
const expectedPath = (root: string) =>
  `node "${join(root, "dist", "cli", "omcp.js")}"`;

// L1.2 dispatcher path helper.
const expectedDispatcherPath = (root: string, event: string) =>
  `node "${join(root, "scripts", "omcp-hook-dispatch.cjs")}" ${event}`;

// Phase B (pre-mortem #1) — when `omcp` is not on PATH, the hook command
// must still dispatch to a working CLI. The fallback emits
// `node "<absolute path to dist/cli/omcp.js>"` so Copilot's pwsh-dispatched
// hook can still resolve the command without relying on PATH.
//
// All tests inject `findOmcpOnPath` and `packageRoot` via the options bag so
// they don't depend on the host filesystem or environment.
describe("resolveDefaultOmcpBin — omcp PATH fallback", () => {
  it("returns literal 'omcp' when on PATH", () => {
    const result = resolveDefaultOmcpBin({
      findOmcpOnPath: () => "/usr/local/bin/omcp",
    });
    expect(result).toBe("omcp");
  });

  it("returns node-wrapped absolute path when NOT on PATH", () => {
    const root = "/opt/oh-my-copilot";
    const result = resolveDefaultOmcpBin({
      findOmcpOnPath: () => null,
      packageRoot: root,
    });
    expect(result).toBe(expectedPath(root));
  });

  it("returns absolute path when PATH lookup returns empty string (treated as found)", () => {
    // findExecutable contract: non-null = found. An empty string is non-null
    // but pathologically empty — we treat it as found to match the contract,
    // so this test asserts the literal-omcp branch.
    const result = resolveDefaultOmcpBin({
      findOmcpOnPath: () => "",
    });
    // Empty string is falsy; should fall through to the absolute-path branch.
    expect(result).toContain('node "');
  });

  it("uses provided packageRoot when emitting absolute path", () => {
    const root = "C:\\Users\\test\\oh-my-copilot";
    const result = resolveDefaultOmcpBin({
      findOmcpOnPath: () => null,
      packageRoot: root,
    });
    expect(result).toBe(expectedPath(root));
  });

  it("handles packageRoot with spaces (always wrapped in quotes)", () => {
    const root = "C:\\Program Files\\oh-my-copilot";
    const result = resolveDefaultOmcpBin({
      findOmcpOnPath: () => null,
      packageRoot: root,
    });
    // The path is wrapped in double quotes so shells (pwsh in particular)
    // handle the embedded space correctly.
    expect(result).toBe(expectedPath(root));
    expect(result).toContain('"'); // quoted form
    expect(result).toContain("Program Files");
  });

  it("falls back to absolute path when finder returns null repeatedly", () => {
    let calls = 0;
    const root = "/x";
    const result = resolveDefaultOmcpBin({
      findOmcpOnPath: () => {
        calls += 1;
        return null;
      },
      packageRoot: root,
    });
    expect(result).toBe(expectedPath(root));
    expect(calls).toBe(1); // single PATH probe per call
  });
});

describe("mergeCopilotHooks — auto-detection of omcpBin", () => {
  it("emits literal 'omcp hook fire ...' when explicit omcpBin override is passed", () => {
    const result = mergeCopilotHooks(undefined, {
      omcpBin: "omcp",
      events: ["SessionStart"],
    });
    const cmd = result["SessionStart"]![0]!.hooks[0]!.command;
    expect(cmd).toBe("omcp hook fire SessionStart --json");
  });

  it("emits a node-wrapped command when explicit omcpBin is an absolute-path-form override", () => {
    const result = mergeCopilotHooks(undefined, {
      omcpBin: 'node "/opt/foo/dist/cli/omcp.js"',
      events: ["SessionStart"],
    });
    const cmd = result["SessionStart"]![0]!.hooks[0]!.command;
    expect(cmd).toBe('node "/opt/foo/dist/cli/omcp.js" hook fire SessionStart --json');
  });

  it("auto-detect path (L1.2): mergeCopilotHooks emits dispatcher form, NEVER bare omcp or multi-arg node", () => {
    // L1.2 changed the contract: when no explicit omcpBin override is given,
    // hook commands use the single-arg wrapper form
    //   node "<abs>/scripts/omcp-hook-dispatch.cjs" <event>
    // instead of the multi-arg form from L1.1
    //   node "<abs>/dist/cli/omcp.js" hook fire <event> --json
    // This avoids pwsh -c argument-parser corruption on Windows.
    const result = mergeCopilotHooks(undefined, { events: ["SessionStart"] });
    const cmd = result["SessionStart"]![0]!.hooks[0]!.command;
    expect(cmd).not.toBe("omcp hook fire SessionStart --json");
    expect(cmd).not.toMatch(/dist[\\/]cli[\\/]omcp\.js.*hook fire/);
    expect(cmd).toMatch(
      /^node ".*scripts[\\/]omcp-hook-dispatch\.cjs" SessionStart$/,
    );
  });
});

describe("resolveHookCommandBin (L1.1) — unconditional absolute-node form for hooks", () => {
  it("returns node-wrapped absolute path even when omcp would be found on PATH", () => {
    // Unlike resolveDefaultOmcpBin which prefers bare "omcp" when on PATH,
    // resolveHookCommandBin must ALWAYS return the absolute-node form. This
    // is the L1.1 fix that bypasses the .ps1/.cmd shim layer for hook
    // dispatch under Copilot+pwsh on Windows.
    const root = "/opt/oh-my-copilot";
    const result = resolveHookCommandBin({ packageRoot: root });
    expect(result).toBe(expectedPath(root));
  });

  it("does NOT consult findOmcpOnPath (unconditional absolute path)", () => {
    let lookupCalls = 0;
    const result = resolveHookCommandBin({
      packageRoot: "/x",
      findOmcpOnPath: () => {
        lookupCalls += 1;
        return "/usr/bin/omcp";
      },
    });
    // Even though finder would say "omcp is on PATH at /usr/bin/omcp",
    // the hook form must NOT use the bare omcp — it always emits node.
    expect(result).toBe(expectedPath("/x"));
    expect(lookupCalls).toBe(0);
  });

  it("handles Windows-style packageRoot with spaces (quoted form)", () => {
    const root = "C:\\Program Files\\oh-my-copilot";
    const result = resolveHookCommandBin({ packageRoot: root });
    expect(result).toBe(expectedPath(root));
    expect(result).toContain('"'); // quoted
    expect(result).toContain("Program Files");
  });

  it("integration: every hook event uses dispatcher form via mergeCopilotHooks (L1.2)", () => {
    // Cover all 13 OMCP_HOOK_EVENTS to confirm none accidentally fall back
    // to the bare form or the L1.1 multi-arg form. This pins L1.2.
    const result = mergeCopilotHooks(undefined);
    const eventNames = Object.keys(result);
    expect(eventNames.length).toBeGreaterThanOrEqual(13);
    for (const event of eventNames) {
      const entry = result[event]?.[0]?.hooks[0];
      expect(entry, `event ${event} should have a hook entry`).toBeDefined();
      expect(entry!.command).toMatch(
        new RegExp(
          `^node ".*scripts[\\\\/]omcp-hook-dispatch\\.cjs" ${event}$`,
        ),
      );
      expect(entry!.command).not.toMatch(/^omcp hook fire/);
      expect(entry!.command).not.toMatch(/dist[\\/]cli[\\/]omcp\.js.*hook fire/);
    }
  });

  it("Stop event consistency: same command shape as other events (Stop regression guard)", () => {
    const result = mergeCopilotHooks(undefined, {
      events: ["Stop", "PostToolUse", "UserPromptSubmit"],
    });
    const stopCmd = result["Stop"]![0]!.hooks[0]!.command;
    const postCmd = result["PostToolUse"]![0]!.hooks[0]!.command;
    const userCmd = result["UserPromptSubmit"]![0]!.hooks[0]!.command;
    // In the L1.2 dispatcher form the event name is the trailing token:
    //   node "<abs>/scripts/omcp-hook-dispatch.cjs" <event>
    // Replace only the trailing event-name token; the rest must match.
    expect(stopCmd.replace(/ Stop$/, " X")).toBe(postCmd.replace(/ PostToolUse$/, " X"));
    expect(stopCmd.replace(/ Stop$/, " X")).toBe(userCmd.replace(/ UserPromptSubmit$/, " X"));
  });
});

describe("resolveHookDispatchCommand (L1.2) — single-arg dispatcher form", () => {
  it("returns dispatcher command with event as trailing token", () => {
    const root = "/opt/oh-my-copilot";
    const result = resolveHookDispatchCommand("PostToolUse", { packageRoot: root });
    expect(result).toBe(expectedDispatcherPath(root, "PostToolUse"));
  });

  it("handles Windows-style packageRoot with spaces", () => {
    const root = "C:\\Program Files\\oh-my-copilot";
    const result = resolveHookDispatchCommand("Stop", { packageRoot: root });
    expect(result).toBe(expectedDispatcherPath(root, "Stop"));
    expect(result).toContain('"');
    expect(result).toContain("Program Files");
  });

  it("does NOT include 'hook fire' or '--json' in the command (wrapper handles those)", () => {
    const root = "/x";
    const result = resolveHookDispatchCommand("SessionStart", { packageRoot: root });
    expect(result).not.toContain("hook fire");
    expect(result).not.toContain("--json");
    expect(result).toContain("omcp-hook-dispatch.cjs");
    expect(result).toMatch(/ SessionStart$/);
  });

  it("points to scripts/omcp-hook-dispatch.cjs (not dist/)", () => {
    const root = "/pkg";
    const result = resolveHookDispatchCommand("PreToolUse", { packageRoot: root });
    expect(result).toContain("scripts");
    expect(result).not.toMatch(/dist[\\/]cli[\\/]omcp\.js/);
  });
});

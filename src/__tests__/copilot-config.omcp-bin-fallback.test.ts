import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  mergeCopilotHooks,
  resolveDefaultOmcpBin,
  resolveHookCommandBin,
} from "../runtime/copilot-config.js";

// path.join uses the host platform's separator. Tests assert against the
// host-resolved join so they pass on both Windows and POSIX runners.
const expectedPath = (root: string) =>
  `node "${join(root, "dist", "cli", "omcp.js")}"`;

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

  it("auto-detect path (L1.1): mergeCopilotHooks always emits absolute-node form, NEVER bare omcp", () => {
    // L1.1 changed the contract: hook commands ALWAYS use the absolute-node
    // form to bypass the npm shim layer (which caused Copilot's pwsh hook
    // executor to trigger Node's eval-stdin SyntaxError on Windows). Even
    // when `omcp` is on PATH, the hook command must NOT use the bare form.
    const result = mergeCopilotHooks(undefined, { events: ["SessionStart"] });
    const cmd = result["SessionStart"]![0]!.hooks[0]!.command;
    expect(cmd).not.toBe("omcp hook fire SessionStart --json");
    expect(cmd).toMatch(
      /^node ".*dist[\\/]cli[\\/]omcp\.js" hook fire SessionStart --json$/,
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

  it("integration: every hook event uses absolute-node form via mergeCopilotHooks", () => {
    // Cover all 13 OMCP_HOOK_EVENTS to confirm none accidentally fall back
    // to the bare form. This is the regression test that pins L1.1.
    const result = mergeCopilotHooks(undefined);
    const eventNames = Object.keys(result);
    expect(eventNames.length).toBeGreaterThanOrEqual(13);
    for (const event of eventNames) {
      const entry = result[event]?.[0]?.hooks[0];
      expect(entry, `event ${event} should have a hook entry`).toBeDefined();
      expect(entry!.command).toMatch(
        new RegExp(
          `^node ".*dist[\\\\/]cli[\\\\/]omcp\\.js" hook fire ${event} --json$`,
        ),
      );
      expect(entry!.command).not.toMatch(/^omcp hook fire/);
    }
  });

  it("Stop event consistency: same command shape as other events (Stop regression guard)", () => {
    const result = mergeCopilotHooks(undefined, {
      events: ["Stop", "PostToolUse", "UserPromptSubmit"],
    });
    const stopCmd = result["Stop"]![0]!.hooks[0]!.command;
    const postCmd = result["PostToolUse"]![0]!.hooks[0]!.command;
    const userCmd = result["UserPromptSubmit"]![0]!.hooks[0]!.command;
    // Replace only the event-name segment; the rest must match.
    expect(stopCmd.replace(/Stop/, "X")).toBe(postCmd.replace(/PostToolUse/, "X"));
    expect(stopCmd.replace(/Stop/, "X")).toBe(userCmd.replace(/UserPromptSubmit/, "X"));
  });
});

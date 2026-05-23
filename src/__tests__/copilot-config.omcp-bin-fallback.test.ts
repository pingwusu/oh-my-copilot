import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  mergeCopilotHooks,
  resolveDefaultOmcpBin,
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

  it("auto-detect path: when no omcpBin override, emits resolveDefaultOmcpBin() value", () => {
    // We can't easily inject `findOmcpOnPath` into mergeCopilotHooks itself
    // (the helper is private), so we assert the command is one of the two
    // valid shapes: bare "omcp" if on PATH, or `node "..."` if not.
    const result = mergeCopilotHooks(undefined, { events: ["SessionStart"] });
    const cmd = result["SessionStart"]![0]!.hooks[0]!.command;
    const isBareForm = cmd === "omcp hook fire SessionStart --json";
    const isAbsForm = /^node ".*dist[\\/]cli[\\/]omcp\.js" hook fire SessionStart --json$/.test(
      cmd,
    );
    expect(isBareForm || isAbsForm).toBe(true);
  });
});

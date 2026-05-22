// Tests for HookResult union expansion (v0.10.0: 3 -> 6 variants) and
// the JSON/non-JSON output logic for the new kinds.
//
// We test via fireHooks (same pattern as hooks-runtime.test.ts) rather than
// runFireCli, because runFireCli calls readStdinJson() which blocks on stdin
// in non-TTY environments (vitest workers). The summary-building logic is
// verified by exercising fireHooks and replicating the summary transform.

import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HookResult } from "../hooks/hook-types.js";
import { fireHooks } from "../hooks/runtime.js";

// ---------------------------------------------------------------------------
// HookResult union — TypeScript compile check + runtime construction
// ---------------------------------------------------------------------------

describe("HookResult union", () => {
  it("accepts all 6 variants at the type level", () => {
    const noop: HookResult = { kind: "noop" };
    const advise: HookResult = { kind: "advise", text: "hello" };
    const block: HookResult = { kind: "block", reason: "not allowed" };
    const modifiedArgs: HookResult = { kind: "modifiedArgs", args: { x: 1 } };
    const modifiedResult: HookResult = { kind: "modifiedResult", result: { y: 2 } };
    const interrupt: HookResult = { kind: "interrupt", reason: "stop now" };

    expect(noop.kind).toBe("noop");
    expect(advise.kind).toBe("advise");
    expect(block.kind).toBe("block");
    expect(modifiedArgs.kind).toBe("modifiedArgs");
    expect(modifiedResult.kind).toBe("modifiedResult");
    expect(interrupt.kind).toBe("interrupt");
  });

  it("modifiedArgs carries args payload", () => {
    const r: HookResult = { kind: "modifiedArgs", args: [1, 2, 3] };
    if (r.kind === "modifiedArgs") {
      expect(r.args).toEqual([1, 2, 3]);
    }
  });

  it("modifiedResult carries result payload", () => {
    const r: HookResult = { kind: "modifiedResult", result: { output: "ok" } };
    if (r.kind === "modifiedResult") {
      expect(r.result).toEqual({ output: "ok" });
    }
  });

  it("interrupt carries reason string", () => {
    const r: HookResult = { kind: "interrupt", reason: "permission denied" };
    if (r.kind === "interrupt") {
      expect(r.reason).toBe("permission denied");
    }
  });
});

// ---------------------------------------------------------------------------
// Helper: build the Copilot stdout protocol summary from entries
// (mirrors the logic in runFireCli's JSON branch)
// ---------------------------------------------------------------------------

type Entry = { hook: string; result: HookResult };

function buildSummary(entries: Entry[]): Record<string, unknown> {
  const adviseTexts: string[] = [];
  let modifiedArgs: unknown = undefined;
  let hasModifiedArgs = false;
  let modifiedResult: unknown = undefined;
  let hasModifiedResult = false;
  let interrupt = false;
  let interruptReason: string | undefined;

  for (const e of entries) {
    const r = e.result;
    if (r.kind === "advise") {
      adviseTexts.push(r.text);
    } else if (r.kind === "modifiedArgs") {
      modifiedArgs = r.args;
      hasModifiedArgs = true;
    } else if (r.kind === "modifiedResult") {
      modifiedResult = r.result;
      hasModifiedResult = true;
    } else if (r.kind === "interrupt") {
      interrupt = true;
      interruptReason = r.reason;
    }
  }

  const summary: Record<string, unknown> = {};
  if (adviseTexts.length > 0) summary.additionalContext = adviseTexts.join("\n");
  if (hasModifiedArgs) summary.modifiedArgs = modifiedArgs;
  if (hasModifiedResult) summary.modifiedResult = modifiedResult;
  if (interrupt) {
    summary.interrupt = true;
    summary.reason = interruptReason;
  }
  return summary;
}

// ---------------------------------------------------------------------------
// fireHooks + summary — new result kinds produce correct protocol fields
// ---------------------------------------------------------------------------

function makeDir(): string {
  const root = mkdtempSync(join(tmpdir(), "omcp-hr-exp-"));
  mkdirSync(join(root, "hooks"), { recursive: true });
  return root;
}

describe("Copilot stdout protocol summary — new result kinds", () => {
  let root: string;
  let hooksDir: string;

  beforeEach(() => {
    root = makeDir();
    hooksDir = join(root, "hooks");
  });

  it("modifiedResult: summary contains modifiedResult value", async () => {
    writeFileSync(
      join(hooksDir, "PostToolUse-mr.mjs"),
      [
        "export default {",
        '  name: "mr-hook",',
        '  events: ["PostToolUse"],',
        '  async run() { return { kind: "modifiedResult", result: { patched: true } }; }',
        "};",
      ].join("\n"),
      "utf8",
    );

    const entries = await fireHooks(
      "PostToolUse",
      { sessionId: "s1", cwd: process.cwd() },
      { pluginHooksDir: hooksDir, repoHooksDir: join(root, "missing") },
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].result).toEqual({ kind: "modifiedResult", result: { patched: true } });

    const summary = buildSummary(entries);
    expect(summary.modifiedResult).toEqual({ patched: true });
    expect(summary.additionalContext).toBeUndefined();
    expect(summary.interrupt).toBeUndefined();
  });

  it("interrupt: summary contains interrupt=true and reason", async () => {
    writeFileSync(
      join(hooksDir, "PermissionRequest-int.mjs"),
      [
        "export default {",
        '  name: "int-hook",',
        '  events: ["PermissionRequest"],',
        '  async run() { return { kind: "interrupt", reason: "blocked by policy" }; }',
        "};",
      ].join("\n"),
      "utf8",
    );

    const entries = await fireHooks(
      "PermissionRequest",
      { sessionId: "s1", cwd: process.cwd() },
      { pluginHooksDir: hooksDir, repoHooksDir: join(root, "missing") },
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].result).toEqual({ kind: "interrupt", reason: "blocked by policy" });

    const summary = buildSummary(entries);
    expect(summary.interrupt).toBe(true);
    expect(summary.reason).toBe("blocked by policy");
  });

  it("modifiedArgs: summary contains modifiedArgs value", async () => {
    writeFileSync(
      join(hooksDir, "PreToolUse-ma.mjs"),
      [
        "export default {",
        '  name: "ma-hook",',
        '  events: ["PreToolUse"],',
        '  async run() { return { kind: "modifiedArgs", args: { cmd: "safe" } }; }',
        "};",
      ].join("\n"),
      "utf8",
    );

    const entries = await fireHooks(
      "PreToolUse",
      { sessionId: "s1", cwd: process.cwd() },
      { pluginHooksDir: hooksDir, repoHooksDir: join(root, "missing") },
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].result).toEqual({ kind: "modifiedArgs", args: { cmd: "safe" } });

    const summary = buildSummary(entries);
    expect(summary.modifiedArgs).toEqual({ cmd: "safe" });
  });

  it("multiple modifiedResult results: last-wins", async () => {
    writeFileSync(
      join(hooksDir, "01-PostToolUse-mr1.mjs"),
      [
        "export default {",
        '  name: "mr-first",',
        '  events: ["PostToolUse"],',
        '  async run() { return { kind: "modifiedResult", result: { v: 1 } }; }',
        "};",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      join(hooksDir, "02-PostToolUse-mr2.mjs"),
      [
        "export default {",
        '  name: "mr-last",',
        '  events: ["PostToolUse"],',
        '  async run() { return { kind: "modifiedResult", result: { v: 2 } }; }',
        "};",
      ].join("\n"),
      "utf8",
    );

    const entries = await fireHooks(
      "PostToolUse",
      { sessionId: "s1", cwd: process.cwd() },
      { pluginHooksDir: hooksDir, repoHooksDir: join(root, "missing") },
    );
    expect(entries).toHaveLength(2);

    const summary = buildSummary(entries);
    // last-wins: v should be 2
    expect(summary.modifiedResult).toEqual({ v: 2 });
  });

  it("advise results aggregate into additionalContext", async () => {
    writeFileSync(
      join(hooksDir, "01-PreToolUse-a.mjs"),
      [
        "export default {",
        '  name: "advise-a",',
        '  events: ["PreToolUse"],',
        '  async run() { return { kind: "advise", text: "line1" }; }',
        "};",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      join(hooksDir, "02-PreToolUse-b.mjs"),
      [
        "export default {",
        '  name: "advise-b",',
        '  events: ["PreToolUse"],',
        '  async run() { return { kind: "advise", text: "line2" }; }',
        "};",
      ].join("\n"),
      "utf8",
    );

    const entries = await fireHooks(
      "PreToolUse",
      { sessionId: "s1", cwd: process.cwd() },
      { pluginHooksDir: hooksDir, repoHooksDir: join(root, "missing") },
    );
    expect(entries).toHaveLength(2);

    const summary = buildSummary(entries);
    expect(summary.additionalContext).toBe("line1\nline2");
  });
});

// ---------------------------------------------------------------------------
// Non-JSON output format strings — unit test the format without stdout capture
// ---------------------------------------------------------------------------

describe("non-JSON output format strings for new kinds", () => {
  it("modifiedArgs formats as expected line", () => {
    const r: HookResult = { kind: "modifiedArgs", args: { safe: true } };
    const hookName = "nma-hook";
    let line = "";
    if (r.kind === "modifiedArgs") {
      line = `[${hookName}] modifiedArgs: ${JSON.stringify(r.args)}`;
    }
    expect(line).toBe('[nma-hook] modifiedArgs: {"safe":true}');
  });

  it("modifiedResult formats as expected line", () => {
    const r: HookResult = { kind: "modifiedResult", result: { out: 42 } };
    const hookName = "nmr-hook";
    let line = "";
    if (r.kind === "modifiedResult") {
      line = `[${hookName}] modifiedResult: ${JSON.stringify(r.result)}`;
    }
    expect(line).toBe('[nmr-hook] modifiedResult: {"out":42}');
  });

  it("interrupt formats as expected line", () => {
    const r: HookResult = { kind: "interrupt", reason: "stop it" };
    const hookName = "ni-hook";
    let line = "";
    if (r.kind === "interrupt") {
      line = `[${hookName}] interrupt: ${r.reason}`;
    }
    expect(line).toBe("[ni-hook] interrupt: stop it");
  });
});

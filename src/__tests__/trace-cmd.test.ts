// Tests for `omcp trace` CLI subcommands.
// Uses OMCP_TRACE_ROOT env override so no .omcp/ is written to the repo root.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runTraceCommand } from "../cli/commands/trace.js";
import { traceAppend } from "../runtime/trace.js";

describe("omcp trace subcommand", () => {
  let tmp: string;
  let traceRoot: string;
  let cwdSnapshot: string;
  let envSnapshot: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "omcp-trace-cmd-"));
    traceRoot = join(tmp, "trace");
    cwdSnapshot = process.cwd();
    envSnapshot = process.env.OMCP_TRACE_ROOT;
    process.env.OMCP_TRACE_ROOT = traceRoot;
    process.chdir(tmp);
  });

  afterEach(() => {
    process.chdir(cwdSnapshot);
    if (envSnapshot === undefined) delete process.env.OMCP_TRACE_ROOT;
    else process.env.OMCP_TRACE_ROOT = envSnapshot;
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("timeline returns empty array for unknown session", () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")));
    runTraceCommand(["timeline", "sess-none"]);
    vi.restoreAllMocks();
    expect(JSON.parse(logs[0])).toEqual([]);
  });

  it("summary returns empty counts for unknown session", () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")));
    runTraceCommand(["summary", "sess-none"]);
    vi.restoreAllMocks();
    expect(JSON.parse(logs[0])).toEqual({ total: 0, byKind: {} });
  });

  it("timeline shows appended events", () => {
    traceAppend("sess1", "hypothesis", { detail: 1 });
    traceAppend("sess1", "evidence", { detail: 2 });
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")));
    runTraceCommand(["timeline", "sess1"]);
    vi.restoreAllMocks();
    const events = JSON.parse(logs[0]) as Array<{ kind: string }>;
    expect(events).toHaveLength(2);
    expect(events[0].kind).toBe("hypothesis");
    expect(events[1].kind).toBe("evidence");
  });

  it("summary counts per kind", () => {
    traceAppend("sess2", "hypothesis");
    traceAppend("sess2", "hypothesis");
    traceAppend("sess2", "evidence");
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")));
    runTraceCommand(["summary", "sess2"]);
    vi.restoreAllMocks();
    expect(JSON.parse(logs[0])).toEqual({
      total: 3,
      byKind: { hypothesis: 2, evidence: 1 },
    });
  });

  it("timeline respects --limit flag", () => {
    for (let i = 0; i < 5; i++) traceAppend("sess3", "tick", { i });
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")));
    runTraceCommand(["timeline", "sess3", "--limit=2"]);
    vi.restoreAllMocks();
    expect(JSON.parse(logs[0])).toHaveLength(2);
  });

  it("timeline missing sessionId sets exitCode=2", () => {
    const errs: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a) => errs.push(a.join(" ")));
    const prevCode = process.exitCode;
    process.exitCode = 0;
    runTraceCommand(["timeline"]);
    vi.restoreAllMocks();
    expect(process.exitCode).toBe(2);
    process.exitCode = prevCode;
  });

  it("unknown subcommand prints help and sets exitCode=2", () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")));
    const prevCode = process.exitCode;
    process.exitCode = 0;
    runTraceCommand(["bogus"]);
    vi.restoreAllMocks();
    expect(logs[0]).toMatch(/Usage: omcp trace/);
    expect(process.exitCode).toBe(2);
    process.exitCode = prevCode;
  });
});

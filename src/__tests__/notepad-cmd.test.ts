// Tests for `omcp notepad` CLI subcommands.
// Uses OMCP_NOTEPAD_PATH env override + process.chdir so no .omcp/ is written
// to the repo root.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runNotepadCommand } from "../cli/commands/notepad.js";

describe("omcp notepad subcommand", () => {
  let tmp: string;
  let notepadFile: string;
  let cwdSnapshot: string;
  let envSnapshot: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "omcp-notepad-cmd-"));
    notepadFile = join(tmp, "notepad.md");
    cwdSnapshot = process.cwd();
    envSnapshot = process.env.OMCP_NOTEPAD_PATH;
    process.env.OMCP_NOTEPAD_PATH = notepadFile;
    process.chdir(tmp);
  });

  afterEach(() => {
    process.chdir(cwdSnapshot);
    if (envSnapshot === undefined) delete process.env.OMCP_NOTEPAD_PATH;
    else process.env.OMCP_NOTEPAD_PATH = envSnapshot;
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("read creates the file and returns empty sections", () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")));
    runNotepadCommand(["read"]);
    vi.restoreAllMocks();
    const parsed = JSON.parse(logs[0]);
    expect(parsed).toEqual({ priority: [], working: [], manual: [] });
  });

  it("write-priority appends to priority section", () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")));
    runNotepadCommand(["write-priority", "stop everything"]);
    vi.restoreAllMocks();
    expect(JSON.parse(logs[0])).toEqual({ ok: true, count: 1 });
    const content = readFileSync(notepadFile, "utf8");
    expect(content).toContain("stop everything");
    expect(content).toContain("## priority");
  });

  it("write-working appends to working section", () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")));
    runNotepadCommand(["write-working", "in progress"]);
    vi.restoreAllMocks();
    expect(JSON.parse(logs[0])).toEqual({ ok: true, count: 1 });
    const content = readFileSync(notepadFile, "utf8");
    expect(content).toContain("in progress");
  });

  it("write-manual appends to manual section", () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")));
    runNotepadCommand(["write-manual", "reference this"]);
    vi.restoreAllMocks();
    expect(JSON.parse(logs[0])).toEqual({ ok: true, count: 1 });
  });

  it("stats returns per-section counts", () => {
    runNotepadCommand(["write-priority", "a"]);
    runNotepadCommand(["write-priority", "b"]);
    runNotepadCommand(["write-working", "c"]);
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")));
    runNotepadCommand(["stats"]);
    vi.restoreAllMocks();
    expect(JSON.parse(logs[0])).toEqual({ priority: 2, working: 1, manual: 0 });
  });

  it("prune clears a section", () => {
    runNotepadCommand(["write-priority", "to clear"]);
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")));
    runNotepadCommand(["prune", "priority"]);
    vi.restoreAllMocks();
    expect(JSON.parse(logs[0])).toEqual({ ok: true });
    // verify section is empty
    const statsLogs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => statsLogs.push(a.join(" ")));
    runNotepadCommand(["stats"]);
    vi.restoreAllMocks();
    expect(JSON.parse(statsLogs[0])).toEqual({ priority: 0, working: 0, manual: 0 });
  });

  it("prune with bad section sets exitCode=2", () => {
    const errs: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a) => errs.push(a.join(" ")));
    const prevCode = process.exitCode;
    process.exitCode = 0;
    runNotepadCommand(["prune", "invalid"]);
    vi.restoreAllMocks();
    expect(process.exitCode).toBe(2);
    process.exitCode = prevCode;
  });

  it("unknown subcommand prints help and sets exitCode=2", () => {
    const logs: string[] = [];
    const errs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...a) => errs.push(a.join(" ")));
    const prevCode = process.exitCode;
    process.exitCode = 0;
    runNotepadCommand(["bogus"]);
    vi.restoreAllMocks();
    expect(logs[0]).toMatch(/Usage: omcp notepad/);
    expect(process.exitCode).toBe(2);
    process.exitCode = prevCode;
  });

  it("no subcommand prints help without setting exitCode", () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")));
    runNotepadCommand([]);
    vi.restoreAllMocks();
    expect(logs[0]).toMatch(/Usage: omcp notepad/);
  });
});

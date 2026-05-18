// Tests for `omcp project-memory` CLI subcommands.
// Uses OMCP_PROJECT_MEMORY env override so no .omcp/ is written to the repo root.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runProjectMemoryCommand } from "../cli/commands/project-memory.js";

describe("omcp project-memory subcommand", () => {
  let tmp: string;
  let pmFile: string;
  let cwdSnapshot: string;
  let envSnapshot: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "omcp-pm-cmd-"));
    pmFile = join(tmp, "project-memory.json");
    cwdSnapshot = process.cwd();
    envSnapshot = process.env.OMCP_PROJECT_MEMORY;
    process.env.OMCP_PROJECT_MEMORY = pmFile;
    process.chdir(tmp);
  });

  afterEach(() => {
    process.chdir(cwdSnapshot);
    if (envSnapshot === undefined) delete process.env.OMCP_PROJECT_MEMORY;
    else process.env.OMCP_PROJECT_MEMORY = envSnapshot;
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("read returns empty memory when file does not exist", () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")));
    runProjectMemoryCommand(["read"]);
    vi.restoreAllMocks();
    expect(JSON.parse(logs[0])).toEqual({ notes: [], directives: [], data: {} });
  });

  it("add-note appends a timestamped note", () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")));
    runProjectMemoryCommand(["add-note", "rebuild after merge"]);
    vi.restoreAllMocks();
    expect(JSON.parse(logs[0])).toEqual({ ok: true, count: 1 });

    // verify via read
    const readLogs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => readLogs.push(a.join(" ")));
    runProjectMemoryCommand(["read"]);
    vi.restoreAllMocks();
    const pm = JSON.parse(readLogs[0]) as { notes: Array<{ text: string }> };
    expect(pm.notes[0].text).toBe("rebuild after merge");
  });

  it("add-directive appends a directive", () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")));
    runProjectMemoryCommand(["add-directive", "never commit .env"]);
    vi.restoreAllMocks();
    expect(JSON.parse(logs[0])).toEqual({ ok: true, count: 1 });

    const readLogs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => readLogs.push(a.join(" ")));
    runProjectMemoryCommand(["read"]);
    vi.restoreAllMocks();
    const pm = JSON.parse(readLogs[0]) as { directives: Array<{ text: string }> };
    expect(pm.directives[0].text).toBe("never commit .env");
  });

  it("write stores JSON value under key", () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")));
    runProjectMemoryCommand(["write", "config-version", "3"]);
    vi.restoreAllMocks();
    expect(JSON.parse(logs[0])).toEqual({ ok: true });

    const readLogs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => readLogs.push(a.join(" ")));
    runProjectMemoryCommand(["read"]);
    vi.restoreAllMocks();
    const pm = JSON.parse(readLogs[0]) as { data: Record<string, unknown> };
    expect(pm.data["config-version"]).toBe(3);
  });

  it("write with non-JSON value treats it as a string", () => {
    runProjectMemoryCommand(["write", "label", "hello world"]);
    const readLogs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => readLogs.push(a.join(" ")));
    runProjectMemoryCommand(["read"]);
    vi.restoreAllMocks();
    const pm = JSON.parse(readLogs[0]) as { data: Record<string, unknown> };
    expect(pm.data["label"]).toBe("hello world");
  });

  it("write missing key sets exitCode=2", () => {
    const errs: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a) => errs.push(a.join(" ")));
    const prevCode = process.exitCode;
    process.exitCode = 0;
    runProjectMemoryCommand(["write"]);
    vi.restoreAllMocks();
    expect(process.exitCode).toBe(2);
    process.exitCode = prevCode;
  });

  it("unknown subcommand prints help and sets exitCode=2", () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")));
    const prevCode = process.exitCode;
    process.exitCode = 0;
    runProjectMemoryCommand(["bogus"]);
    vi.restoreAllMocks();
    expect(logs[0]).toMatch(/Usage: omcp project-memory/);
    expect(process.exitCode).toBe(2);
    process.exitCode = prevCode;
  });

  it("no subcommand prints help without setting exitCode", () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")));
    runProjectMemoryCommand([]);
    vi.restoreAllMocks();
    expect(logs[0]).toMatch(/Usage: omcp project-memory/);
  });
});

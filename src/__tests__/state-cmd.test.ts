import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearAllState,
  clearState,
  formatStateList,
  listStateFiles,
  readState,
  writeState,
} from "../cli/commands/state.js";

describe("omcp state subcommand", () => {
  let tmp: string;
  let cwdSnapshot: string;
  let sessionEnvSnapshot: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "omcp-state-cmd-"));
    cwdSnapshot = process.cwd();
    process.chdir(tmp);
    sessionEnvSnapshot = process.env.COPILOT_SESSION_ID;
    delete process.env.COPILOT_SESSION_ID;
  });

  afterEach(() => {
    process.chdir(cwdSnapshot);
    if (sessionEnvSnapshot === undefined) delete process.env.COPILOT_SESSION_ID;
    else process.env.COPILOT_SESSION_ID = sessionEnvSnapshot;
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("list returns [] when no state files exist", () => {
    expect(listStateFiles()).toEqual([]);
    expect(formatStateList([])).toMatch(/no state files/);
  });

  it("write then read round-trips a fake ralph state", () => {
    const body = { active: true, iteration: 4, max_iterations: 10 };
    const path = writeState("ralph", body);
    expect(existsSync(path)).toBe(true);
    expect(readState("ralph")).toEqual(body);
  });

  it("list surfaces written entries with the active flag", () => {
    writeState("ralph", { active: true, iteration: 1 });
    writeState("autopilot", { active: false, phase: "execution" });
    const entries = listStateFiles();
    const modes = entries.map((e) => `${e.mode}:${e.active}`).sort();
    expect(modes).toEqual(["autopilot:false", "ralph:true"]);
  });

  it("clear removes a single mode file", () => {
    writeState("ralph", { active: true });
    expect(clearState("ralph")).toBe(true);
    expect(readState("ralph")).toBeNull();
    // Idempotent — clearing again returns false rather than throwing.
    expect(clearState("ralph")).toBe(false);
  });

  it("clear-all removes every *-state.json and cancel.json", () => {
    writeState("ralph", { active: true });
    writeState("autopilot", { active: true });
    // Drop a cancel marker alongside the state files.
    mkdirSync(join(tmp, ".omcp", "state"), { recursive: true });
    writeFileSync(
      join(tmp, ".omcp", "state", "cancel.json"),
      JSON.stringify({ cancelled_at: "2026-05-18" }),
    );

    const report = clearAllState();
    expect(report.removed.length).toBe(3);
    expect(listStateFiles()).toEqual([]);
    expect(existsSync(join(tmp, ".omcp", "state", "cancel.json"))).toBe(false);
  });

  it("honours COPILOT_SESSION_ID for session isolation", () => {
    process.env.COPILOT_SESSION_ID = "sess-abc";
    writeState("ralph", { active: true, iteration: 7 });
    const scoped = join(
      tmp,
      ".omcp",
      "state",
      "sessions",
      "sess-abc",
      "ralph-state.json",
    );
    expect(existsSync(scoped)).toBe(true);
    expect(JSON.parse(readFileSync(scoped, "utf8"))).toEqual({
      active: true,
      iteration: 7,
    });
    // The unscoped root must not have leaked a copy.
    expect(existsSync(join(tmp, ".omcp", "state", "ralph-state.json"))).toBe(false);
  });

  it("formatStateList renders one row per mode", () => {
    writeState("ralph", { active: true });
    const out = formatStateList(listStateFiles());
    expect(out).toMatch(/omcp state \(1\)/);
    expect(out).toMatch(/ralph/);
    expect(out).toMatch(/active/);
  });
});

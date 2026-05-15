import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listSessions, formatSessions } from "../cli/commands/session.js";
import { readStatus, formatStatus } from "../cli/commands/status.js";

describe("session listing", () => {
  let tmp: string;
  let cwdSnapshot: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "omcp-session-"));
    cwdSnapshot = process.cwd();
    process.chdir(tmp);
  });
  afterEach(() => {
    process.chdir(cwdSnapshot);
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("returns empty when no sessions exist", () => {
    expect(listSessions()).toEqual([]);
    expect(formatSessions([])).toMatch(/no sessions found/);
  });

  it("lists sessions with worker logs", () => {
    const dir = join(tmp, ".omcp", "state", "sessions", "abc123");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "worker-1.log"), "hello world");
    writeFileSync(join(dir, "worker-2.log"), "hello again");

    const sessions = listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe("abc123");
    expect(sessions[0].workerLogs).toHaveLength(2);
  });

  it("counts matches when query provided", () => {
    const dir = join(tmp, ".omcp", "state", "sessions", "abc");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "worker-1.log"), "error error fail");
    const sessions = listSessions("error");
    expect(sessions[0].matches).toBe(2);
  });
});

describe("status", () => {
  let tmp: string;
  let cwdSnapshot: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "omcp-status-"));
    cwdSnapshot = process.cwd();
    process.chdir(tmp);
  });
  afterEach(() => {
    process.chdir(cwdSnapshot);
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("reports clean state when no .omcp dir", () => {
    const s = readStatus();
    expect(s.cancelled).toBe(false);
    expect(s.activeModes).toEqual([]);
    expect(s.sessions).toBe(0);
  });

  it("detects cancel marker", () => {
    mkdirSync(join(tmp, ".omcp", "state"), { recursive: true });
    writeFileSync(
      join(tmp, ".omcp", "state", "cancel.json"),
      JSON.stringify({ cancelled_at: "2026-05-15", reason: "user" }),
    );
    const s = readStatus();
    expect(s.cancelled).toBe(true);
    expect(s.cancelReason).toBe("user");
  });

  it("reads active modes, ralph iter, team workers", () => {
    const sd = join(tmp, ".omcp", "state");
    mkdirSync(sd, { recursive: true });
    writeFileSync(
      join(sd, "mode.json"),
      JSON.stringify({ modes: ["ralph", "autopilot"] }),
    );
    writeFileSync(
      join(sd, "ralph.json"),
      JSON.stringify({ iteration: 3, max: 10 }),
    );
    writeFileSync(
      join(sd, "team.json"),
      JSON.stringify({ done: 2, spawned: 5 }),
    );
    const s = readStatus();
    expect(s.activeModes).toEqual(["ralph", "autopilot"]);
    expect(s.ralphIteration).toEqual({ current: 3, max: 10 });
    expect(s.teamWorkers).toEqual({ done: 2, spawned: 5 });
  });

  it("formats status as multi-line", () => {
    const s = readStatus();
    const text = formatStatus(s);
    expect(text).toMatch(/omcp status:/);
    expect(text).toMatch(/sessions: 0/);
  });

  it("readStatus does not throw if .omcp exists but state files are absent", () => {
    mkdirSync(join(tmp, ".omcp", "state"), { recursive: true });
    expect(existsSync(join(tmp, ".omcp", "state"))).toBe(true);
    expect(() => readStatus()).not.toThrow();
  });
});

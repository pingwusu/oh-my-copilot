// Tests for loop-watcher TOCTOU fix (Defect 2).
//
// The fix replaces the old isRunning()-check + writeFileSync() sequence (TOCTOU)
// with openSync(pidFile, "wx") which atomically fails with EEXIST if the pidfile
// already exists, closing the race window.

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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { statusWatcher, stopWatcher } from "../cli/commands/loop-watcher.js";

// Import startWatcher separately so we can test it in isolation.
// We avoid actually spawning real subprocesses in most tests to prevent
// vitest worker-pool interference from detached child exits.

describe("loop-watcher TOCTOU fix", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "omcp-lw-test-"));
    vi.spyOn(process, "cwd").mockReturnValue(tmp);
    mkdirSync(join(tmp, ".omcp", "state"), { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("throws 'already running' when pidfile exists with a live pid (EEXIST path)", async () => {
    const { startWatcher } = await import("../cli/commands/loop-watcher.js");
    // Write a pidfile with our own (definitely live) pid.
    const pidPath = join(tmp, ".omcp", "state", "loop-watcher.pid");
    writeFileSync(pidPath, String(process.pid));

    // startWatcher must throw because our pid is alive.
    expect(() => startWatcher("/nonexistent-script.js")).toThrow(/already running/);

    // Pidfile must still exist — we must not have clobbered it.
    expect(existsSync(pidPath)).toBe(true);
    expect(readFileSync(pidPath, "utf8").trim()).toBe(String(process.pid));
  });

  it("recovers stale pidfile (dead pid) without throwing 'already running'", async () => {
    const { startWatcher } = await import("../cli/commands/loop-watcher.js");
    // 9999999 is extremely unlikely to be a live user process.
    const deadPid = 9999999;
    const pidPath = join(tmp, ".omcp", "state", "loop-watcher.pid");
    writeFileSync(pidPath, String(deadPid));

    // startWatcher should NOT throw "already running" for a dead pid.
    // It will try to spawn process.execPath; catch any spawn error but not
    // "already running".
    let threwAlreadyRunning = false;
    try {
      startWatcher("/nonexistent-path-that-will-fail-to-spawn");
    } catch (e: unknown) {
      if ((e as Error).message?.includes("already running")) threwAlreadyRunning = true;
    }
    expect(threwAlreadyRunning).toBe(false);

    // The new pidfile must NOT contain the stale dead pid.
    // (It may or may not exist depending on whether spawn succeeded.)
    if (existsSync(pidPath)) {
      const written = Number(readFileSync(pidPath, "utf8").trim());
      expect(written).not.toBe(deadPid);
    }
  });

  it("stopWatcher removes the pidfile and reports stopped", () => {
    const pidPath = join(tmp, ".omcp", "state", "loop-watcher.pid");
    writeFileSync(pidPath, String(process.pid));

    const result = stopWatcher();
    expect(result.stopped).toBe(true);
    expect(existsSync(pidPath)).toBe(false);
  });

  it("stopWatcher returns stopped=false when no pidfile exists", () => {
    const result = stopWatcher();
    expect(result.stopped).toBe(false);
  });

  it("statusWatcher reports running=false when no pidfile exists", () => {
    const result = statusWatcher();
    expect(result.running).toBe(false);
  });

  it("statusWatcher reports running=true when pidfile has a live pid", () => {
    const pidPath = join(tmp, ".omcp", "state", "loop-watcher.pid");
    writeFileSync(pidPath, String(process.pid));
    const result = statusWatcher();
    expect(result.running).toBe(true);
    expect(result.pid).toBe(process.pid);
  });

  it("sequential start calls: second call throws because first holds pidfile", async () => {
    const { startWatcher } = await import("../cli/commands/loop-watcher.js");
    const pidPath = join(tmp, ".omcp", "state", "loop-watcher.pid");

    // Simulate what startWatcher does when it succeeds: write our own pid
    // as if we are the started watcher.
    writeFileSync(pidPath, String(process.pid));

    // Second call: must throw "already running" because pidfile exists with live pid.
    expect(() => startWatcher("/nonexistent-script.js")).toThrow(/already running/);
  });

  it("openSync wx flag: second writer gets EEXIST when pidfile already exists", () => {
    // Unit-test the atomic primitive directly, without involving startWatcher.
    const { openSync, closeSync } = require("node:fs") as typeof import("node:fs");
    const pidPath = join(tmp, ".omcp", "state", "loop-watcher.pid");

    // First open: succeeds.
    const fd = openSync(pidPath, "wx");
    closeSync(fd);

    // Second open: must throw EEXIST.
    expect(() => openSync(pidPath, "wx")).toThrow(
      expect.objectContaining({ code: "EEXIST" }),
    );
  });
});

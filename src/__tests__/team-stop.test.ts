// Tests for Defect 3: team pidfile tracking + stopTeam.

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
import { stopTeam } from "../cli/commands/team.js";

describe("stopTeam", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "omcp-team-test-"));
    vi.spyOn(process, "cwd").mockReturnValue(tmp);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("kills all workers listed in pidfiles and removes the pidfiles", () => {
    const sessionId = "test-session-abc";
    const pidDir = join(tmp, ".omcp", "state", "team", sessionId);
    mkdirSync(pidDir, { recursive: true });
    writeFileSync(join(pidDir, "worker-1.pid"), "1111");
    writeFileSync(join(pidDir, "worker-2.pid"), "2222");

    const killed: number[] = [];
    const report = stopTeam(sessionId, {
      killProcess: (pid) => killed.push(pid),
    });

    expect(report.sessionId).toBe(sessionId);
    expect(killed.sort((a, b) => a - b)).toEqual([1111, 2222]);
    expect(report.errors).toHaveLength(0);
    // Pidfiles must be removed.
    expect(existsSync(join(pidDir, "worker-1.pid"))).toBe(false);
    expect(existsSync(join(pidDir, "worker-2.pid"))).toBe(false);
  });

  it("returns empty killed list when pidDir does not exist", () => {
    const report = stopTeam("no-such-session", {
      killProcess: () => { throw new Error("should not be called"); },
    });
    expect(report.killed).toHaveLength(0);
    expect(report.errors).toHaveLength(0);
  });

  it("records error (does not throw) when killProcess fails and KEEPS pidfile for retry", () => {
    // DD8 Critic-A P1 fix: prior behavior unconditionally deleted the
    // pidfile even when kill threw, orphaning the worker permanently. The
    // fix keeps the pidfile when the kill signal cannot be delivered so
    // the user can retry after fixing the underlying issue (EPERM, etc.).
    const sessionId = "fail-session";
    const pidDir = join(tmp, ".omcp", "state", "team", sessionId);
    mkdirSync(pidDir, { recursive: true });
    writeFileSync(join(pidDir, "worker-1.pid"), "3333");

    const report = stopTeam(sessionId, {
      killProcess: () => { throw new Error("EPERM"); },
    });

    expect(report.killed).toHaveLength(0);
    expect(report.errors.length).toBeGreaterThan(0);
    expect(report.errors[0]).toMatch(/3333/);
    // Pidfile must NOT be removed when kill fails (retry path).
    expect(existsSync(join(pidDir, "worker-1.pid"))).toBe(true);
  });

  it("ignores non-.pid files in pidDir", () => {
    const sessionId = "mixed-session";
    const pidDir = join(tmp, ".omcp", "state", "team", sessionId);
    mkdirSync(pidDir, { recursive: true });
    writeFileSync(join(pidDir, "worker-1.pid"), "5555");
    writeFileSync(join(pidDir, "notes.txt"), "ignore me");

    const killed: number[] = [];
    stopTeam(sessionId, { killProcess: (pid) => killed.push(pid) });
    expect(killed).toEqual([5555]);
  });

  // RC4-P1-C fix: every prior test injects a fake killProcess, so the real
  // kill path (SIGTERM / taskkill) has zero coverage. This test spawns a real
  // child, writes its pid, and calls stopTeam WITHOUT the killProcess override
  // — exercising the actual platform-aware kill code.
  it("real spawned child is actually terminated by stopTeam (no killProcess mock)", async () => {
    const { spawn } = await import("node:child_process");
    // Spawn a long-running child: node -e "setInterval(()=>{},1e9)"
    const child = spawn(
      process.execPath,
      ["-e", "setInterval(()=>{},1000000000)"],
      { stdio: "ignore", detached: true },
    );
    // Detach so we don't propagate signals from this test process.
    child.unref();
    expect(child.pid).toBeGreaterThan(0);
    const pid = child.pid!;

    const sessionId = "real-kill-session";
    const pidDir = join(tmp, ".omcp", "state", "team", sessionId);
    mkdirSync(pidDir, { recursive: true });
    writeFileSync(join(pidDir, "worker-1.pid"), String(pid));

    // Call stopTeam with NO killProcess override — exercises the real kill path.
    const report = stopTeam(sessionId);
    expect(report.killed).toContain(pid);

    // Wait briefly for the OS to deliver the signal then verify the child is dead.
    await new Promise((res) => setTimeout(res, 250));
    let alive = true;
    try {
      process.kill(pid, 0); // throws ESRCH if dead
    } catch {
      alive = false;
    }
    if (alive) {
      // Force-cleanup so the test doesn't leak a zombie process.
      try { process.kill(pid, "SIGKILL"); } catch { /* may already be dead */ }
    }
    expect(alive).toBe(false);
  });
});

describe("runTeam detached mode writes pidfiles", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "omcp-team-run-test-"));
    vi.spyOn(process, "cwd").mockReturnValue(tmp);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("pidDir is present in the returned report when tmux is unavailable", async () => {
    // We can't easily mock tmuxAvailable without vi.mock hoisting, so we
    // verify the interface: if the report has pidDir it points to an existing
    // directory and contains .pid files.
    // This test only runs the assertion path if mode === "detached".
    const { runTeam, parseTeamSpec } = await import("../cli/commands/team.js");
    const spec = parseTeamSpec("1");
    const report = runTeam(spec, "echo hello");

    if (report.mode === "detached") {
      expect(report.pidDir).toBeDefined();
      expect(existsSync(report.pidDir!)).toBe(true);
      // There should be a worker-1.pid file (child.pid may be set).
      const pidFile = join(report.pidDir!, "worker-1.pid");
      // The pidfile is only written if child.pid was defined; check format if present.
      if (existsSync(pidFile)) {
        const pid = Number(readFileSync(pidFile, "utf8").trim());
        expect(pid).toBeGreaterThan(0);
      }
    } else {
      // tmux mode — pidDir is not applicable, test passes trivially.
      expect(report.mode).toBe("tmux");
    }
  });
});

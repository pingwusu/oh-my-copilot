import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runStateUltrawork } from "../state-ultrawork.js";
import { activateUltrawork } from "../../../lib/ultrawork-state.js";
import { clearWorktreeCache } from "../../../lib/worktree-paths.js";

function makeWorktree(): string {
  const dir = mkdtempSync(join(tmpdir(), "omcp-state-ultrawork-"));
  execSync("git init --quiet", { cwd: dir });
  execSync("git config user.email test@example.com", { cwd: dir });
  execSync("git config user.name test", { cwd: dir });
  return dir;
}

describe("runStateUltrawork", () => {
  let dir: string;
  let logs: string[];
  let errs: string[];
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    clearWorktreeCache();
    dir = makeWorktree();
    logs = [];
    errs = [];
    logSpy = vi.spyOn(console, "log").mockImplementation((...a) => {
      logs.push(a.map(String).join(" "));
    });
    errSpy = vi.spyOn(console, "error").mockImplementation((...a) => {
      errs.push(a.map(String).join(" "));
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    clearWorktreeCache();
    rmSync(dir, { recursive: true, force: true });
  });

  it("status returns 0 and prints no-state message when nothing is stored", () => {
    const code = runStateUltrawork(["status"], dir);
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("no active state");
  });

  it("start <prompt> writes new active state", () => {
    const code = runStateUltrawork(["start", "do", "the", "thing"], dir);
    expect(code).toBe(0);
    const file = join(dir, ".omcp", "state", "ultrawork-state.json");
    expect(existsSync(file)).toBe(true);
    const body = JSON.parse(readFileSync(file, "utf8"));
    expect(body.active).toBe(true);
    expect(body.originalPrompt).toBe("do the thing");
    expect(body.reinforcementCount).toBe(0);
  });

  it("start with no prompt argument returns exit 2", () => {
    const code = runStateUltrawork(["start"], dir);
    expect(code).toBe(2);
    expect(errs.join("\n")).toContain("<prompt> argument required");
  });

  it("status after start surfaces the active state", () => {
    runStateUltrawork(["start", "beta"], dir);
    logs.length = 0;
    const code = runStateUltrawork(["status"], dir);
    expect(code).toBe(0);
    const out = logs.join("\n");
    expect(out).toContain("active:              true");
    expect(out).toContain("originalPrompt:      beta");
    expect(out).toContain("reinforcementCount:  0");
  });

  it("clear removes the state file", () => {
    activateUltrawork("seed", { worktreeRoot: dir });
    const code = runStateUltrawork(["clear"], dir);
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("clear: yes");
    expect(
      existsSync(join(dir, ".omcp", "state", "ultrawork-state.json")),
    ).toBe(false);
  });

  it("unknown subcommand returns exit 2 with help text", () => {
    const code = runStateUltrawork(["nope"], dir);
    expect(code).toBe(2);
    expect(errs.join("\n")).toContain("unknown subcommand 'nope'");
  });

  it("missing subcommand returns exit 2 with help text", () => {
    const code = runStateUltrawork([], dir);
    expect(code).toBe(2);
    expect(errs.join("\n")).toContain("missing subcommand");
  });
});

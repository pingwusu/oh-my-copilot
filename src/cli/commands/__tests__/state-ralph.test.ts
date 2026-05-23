import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runStateRalph } from "../state-ralph.js";
import { writeRalphState } from "../../../lib/ralph-state.js";
import { clearWorktreeCache } from "../../../lib/worktree-paths.js";

function makeWorktree(): string {
  const dir = mkdtempSync(join(tmpdir(), "omcp-state-ralph-"));
  execSync("git init --quiet", { cwd: dir });
  execSync("git config user.email test@example.com", { cwd: dir });
  execSync("git config user.name test", { cwd: dir });
  return dir;
}

describe("runStateRalph", () => {
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
    const code = runStateRalph(["status"], dir);
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("no active state");
  });

  it("start <task> writes new state with iteration 1 and prompts", () => {
    const code = runStateRalph(["start", "port", "the", "thing"], dir);
    expect(code).toBe(0);
    const file = join(dir, ".omcp", "state", "ralph-state.json");
    expect(existsSync(file)).toBe(true);
    const body = JSON.parse(readFileSync(file, "utf8"));
    expect(body.active).toBe(true);
    expect(body.iteration).toBe(1);
    expect(body.prompt).toBe("port the thing");
  });

  it("start with no task argument returns exit 2", () => {
    const code = runStateRalph(["start"], dir);
    expect(code).toBe(2);
    expect(errs.join("\n")).toContain("<task> argument required");
  });

  it("status after start surfaces the active state", () => {
    runStateRalph(["start", "alpha"], dir);
    logs.length = 0;
    const code = runStateRalph(["status"], dir);
    expect(code).toBe(0);
    const out = logs.join("\n");
    expect(out).toContain("active:       true");
    expect(out).toContain("iteration:    1");
    expect(out).toContain("prompt:       alpha");
  });

  it("iterate bumps the iteration counter on an active state", () => {
    runStateRalph(["start", "alpha"], dir);
    logs.length = 0;
    const code = runStateRalph(["iterate"], dir);
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("iteration 2");
    const body = JSON.parse(
      readFileSync(join(dir, ".omcp", "state", "ralph-state.json"), "utf8"),
    );
    expect(body.iteration).toBe(2);
  });

  it("iterate with no active state returns exit 1", () => {
    const code = runStateRalph(["iterate"], dir);
    expect(code).toBe(1);
    expect(errs.join("\n")).toContain("no active state");
  });

  it("clear removes the state file and reports yes", () => {
    writeRalphState(
      {
        active: true,
        iteration: 3,
        lastFiredAt: "2026-05-23T00:00:00.000Z",
        prompt: "x",
      },
      dir,
    );
    const code = runStateRalph(["clear"], dir);
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("clear: yes");
    expect(existsSync(join(dir, ".omcp", "state", "ralph-state.json"))).toBe(false);
  });

  it("clear with no state file still reports success", () => {
    const code = runStateRalph(["clear"], dir);
    expect(code).toBe(0);
  });

  it("unknown subcommand returns exit 2 with help text", () => {
    const code = runStateRalph(["wat"], dir);
    expect(code).toBe(2);
    expect(errs.join("\n")).toContain("unknown subcommand 'wat'");
  });

  it("missing subcommand returns exit 2 with help text", () => {
    const code = runStateRalph([], dir);
    expect(code).toBe(2);
    expect(errs.join("\n")).toContain("missing subcommand");
  });

  it("status falls back gracefully when state file has malformed JSON", () => {
    const stateDir = join(dir, ".omcp", "state");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "ralph-state.json"), "not json");
    const code = runStateRalph(["status"], dir);
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("no active state");
  });
});

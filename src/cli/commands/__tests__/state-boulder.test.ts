import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runStateBoulder } from "../state-boulder.js";
import {
  createBoulderState,
  writeBoulderState,
} from "../../../lib/boulder-state.js";
import { clearWorktreeCache } from "../../../lib/worktree-paths.js";

function makeWorktree(): string {
  const dir = mkdtempSync(join(tmpdir(), "omcp-state-boulder-"));
  execSync("git init --quiet", { cwd: dir });
  execSync("git config user.email test@example.com", { cwd: dir });
  execSync("git config user.name test", { cwd: dir });
  return dir;
}

describe("runStateBoulder", () => {
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

  it("missing subcommand returns exit 2", () => {
    const code = runStateBoulder([], dir);
    expect(code).toBe(2);
    expect(errs.join("\n")).toContain("missing subcommand");
  });

  it("unknown subcommand returns exit 2", () => {
    const code = runStateBoulder(["zzz"], dir);
    expect(code).toBe(2);
    expect(errs.join("\n")).toContain("unknown subcommand 'zzz'");
  });

  it("status with no boulder prints no-active message", () => {
    const code = runStateBoulder(["status"], dir);
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("no active boulder");
  });

  it("status with an active boulder surfaces plan name + session ids", () => {
    const plansDir = join(dir, ".omcp", "plans");
    mkdirSync(plansDir, { recursive: true });
    const planPath = join(plansDir, "ship-it.md");
    writeFileSync(planPath, "# ship-it\n- [ ] do one\n- [x] do two\n");
    const state = createBoulderState(planPath, "sess-1");
    writeBoulderState(state, dir);

    const code = runStateBoulder(["status"], dir);
    expect(code).toBe(0);
    const out = logs.join("\n");
    expect(out).toContain("active:        true");
    expect(out).toContain("planName:      ship-it");
    expect(out).toContain("sess-1");
  });

  it("list-plans prints zero count when .omcp/plans/ is empty", () => {
    const code = runStateBoulder(["list-plans"], dir);
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("no plans in .omcp/plans/");
  });

  it("list-plans surfaces every plan with checklist progress", () => {
    const plansDir = join(dir, ".omcp", "plans");
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(
      join(plansDir, "alpha.md"),
      "# alpha\n- [ ] a\n- [x] b\n- [ ] c\n",
    );
    writeFileSync(
      join(plansDir, "beta.md"),
      "# beta\n- [x] done\n- [x] also done\n",
    );

    const code = runStateBoulder(["list-plans"], dir);
    expect(code).toBe(0);
    const out = logs.join("\n");
    expect(out).toContain("alpha");
    expect(out).toContain("1/3");
    expect(out).toContain("beta");
    expect(out).toContain("2/2");
  });

  it("clear removes boulder state and reports yes", () => {
    const plansDir = join(dir, ".omcp", "plans");
    mkdirSync(plansDir, { recursive: true });
    const planPath = join(plansDir, "tmp.md");
    writeFileSync(planPath, "# tmp\n");
    writeBoulderState(createBoulderState(planPath, "sess-x"), dir);

    const code = runStateBoulder(["clear"], dir);
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("clear: yes");
    expect(existsSync(join(dir, ".omcp", "state", "boulder-state.json"))).toBe(
      false,
    );
  });

  it("clear with no state still reports success", () => {
    const code = runStateBoulder(["clear"], dir);
    expect(code).toBe(0);
  });
});

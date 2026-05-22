import { execSync } from "node:child_process";
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

import {
  activateUltrawork,
  clearLinkedUltraworkState,
  clearUltraworkState,
  deactivateUltrawork,
  getUltraworkPersistenceMessage,
  incrementReinforcement,
  readUltraworkState,
  shouldReinforceUltrawork,
  writeUltraworkState,
  type UltraworkState,
} from "../ultrawork-state.js";
import { clearWorktreeCache } from "../worktree-paths.js";

function initRepo(dir: string): void {
  execSync("git init --quiet", { cwd: dir });
  execSync("git config user.email test@example.com", { cwd: dir });
  execSync("git config user.name test", { cwd: dir });
}

function makeWorktree(): string {
  const dir = mkdtempSync(join(tmpdir(), "omcp-ulw-"));
  initRepo(dir);
  return dir;
}

function freshState(overrides: Partial<UltraworkState> = {}): UltraworkState {
  return {
    active: true,
    startedAt: "2026-05-22T17:00:00.000Z",
    originalPrompt: "test prompt",
    reinforcementCount: 0,
    lastCheckedAt: "2026-05-22T17:00:00.000Z",
    ...overrides,
  };
}

describe("read/write ultrawork state", () => {
  let dir: string;

  beforeEach(() => {
    clearWorktreeCache();
    dir = makeWorktree();
  });

  afterEach(() => {
    clearWorktreeCache();
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null when no state file exists", () => {
    expect(readUltraworkState(dir)).toBeNull();
  });

  it("round-trips a minimal active state", () => {
    const state = freshState();
    expect(writeUltraworkState(state, dir)).toBe(true);
    expect(readUltraworkState(dir)).toEqual(state);
  });

  it("round-trips linkedToRalph when set", () => {
    writeUltraworkState(freshState({ linkedToRalph: true }), dir);
    expect(readUltraworkState(dir)?.linkedToRalph).toBe(true);
  });

  it("write creates .omcp/state/ if missing", () => {
    writeUltraworkState(freshState(), dir);
    expect(
      existsSync(join(dir, ".omcp", "state", "ultrawork-state.json")),
    ).toBe(true);
  });

  it("malformed JSON yields null", () => {
    const stateDir = join(dir, ".omcp", "state");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "ultrawork-state.json"), "not json");
    expect(readUltraworkState(dir)).toBeNull();
  });

  it("schema violations yield null", () => {
    const stateDir = join(dir, ".omcp", "state");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, "ultrawork-state.json"),
      JSON.stringify({ active: "yes" }),
    );
    expect(readUltraworkState(dir)).toBeNull();
  });
});

describe("activate / deactivate / clear", () => {
  let dir: string;

  beforeEach(() => {
    clearWorktreeCache();
    dir = makeWorktree();
  });

  afterEach(() => {
    clearWorktreeCache();
    rmSync(dir, { recursive: true, force: true });
  });

  it("activate writes a state with active=true and reinforcementCount=0", () => {
    expect(activateUltrawork("do the thing", { worktreeRoot: dir })).toBe(true);
    const state = readUltraworkState(dir);
    expect(state?.active).toBe(true);
    expect(state?.originalPrompt).toBe("do the thing");
    expect(state?.reinforcementCount).toBe(0);
  });

  it("activate honors linkedToRalph", () => {
    activateUltrawork("p", { worktreeRoot: dir, linkedToRalph: true });
    expect(readUltraworkState(dir)?.linkedToRalph).toBe(true);
  });

  it("deactivate removes the state file", () => {
    activateUltrawork("p", { worktreeRoot: dir });
    expect(deactivateUltrawork(dir)).toBe(true);
    expect(readUltraworkState(dir)).toBeNull();
  });

  it("clearUltraworkState is idempotent when state is missing", () => {
    expect(clearUltraworkState(dir)).toBe(true);
  });
});

describe("clearLinkedUltraworkState", () => {
  let dir: string;

  beforeEach(() => {
    clearWorktreeCache();
    dir = makeWorktree();
  });

  afterEach(() => {
    clearWorktreeCache();
    rmSync(dir, { recursive: true, force: true });
  });

  it("clears state when linkedToRalph=true", () => {
    activateUltrawork("p", { worktreeRoot: dir, linkedToRalph: true });
    expect(clearLinkedUltraworkState(dir)).toBe(true);
    expect(readUltraworkState(dir)).toBeNull();
  });

  it("preserves state when linkedToRalph=false (stand-alone session)", () => {
    activateUltrawork("p", { worktreeRoot: dir, linkedToRalph: false });
    expect(clearLinkedUltraworkState(dir)).toBe(true);
    expect(readUltraworkState(dir)).not.toBeNull();
  });

  it("no-op (returns true) when no state exists", () => {
    expect(clearLinkedUltraworkState(dir)).toBe(true);
  });
});

describe("incrementReinforcement", () => {
  let dir: string;

  beforeEach(() => {
    clearWorktreeCache();
    dir = makeWorktree();
  });

  afterEach(() => {
    clearWorktreeCache();
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null with no state", () => {
    expect(incrementReinforcement(dir)).toBeNull();
  });

  it("returns null when state is inactive", () => {
    writeUltraworkState(freshState({ active: false }), dir);
    expect(incrementReinforcement(dir)).toBeNull();
  });

  it("bumps count and refreshes lastCheckedAt", () => {
    writeUltraworkState(freshState({ reinforcementCount: 2 }), dir);
    const updated = incrementReinforcement(dir);
    expect(updated?.reinforcementCount).toBe(3);
    expect(updated?.lastCheckedAt).not.toBe("2026-05-22T17:00:00.000Z");
  });
});

describe("shouldReinforceUltrawork", () => {
  let dir: string;

  beforeEach(() => {
    clearWorktreeCache();
    dir = makeWorktree();
  });

  afterEach(() => {
    clearWorktreeCache();
    rmSync(dir, { recursive: true, force: true });
  });

  it("false when no state", () => {
    expect(shouldReinforceUltrawork(dir)).toBe(false);
  });

  it("false when state.active=false", () => {
    writeUltraworkState(freshState({ active: false }), dir);
    expect(shouldReinforceUltrawork(dir)).toBe(false);
  });

  it("true when state.active=true", () => {
    writeUltraworkState(freshState({ active: true }), dir);
    expect(shouldReinforceUltrawork(dir)).toBe(true);
  });
});

describe("getUltraworkPersistenceMessage", () => {
  it("includes reinforcement number = count + 1 and the original prompt", () => {
    const message = getUltraworkPersistenceMessage(
      freshState({ reinforcementCount: 4, originalPrompt: "porting omc" }),
    );
    expect(message).toContain("Reinforcement #5");
    expect(message).toContain("porting omc");
    expect(message).toContain("<ultrawork-persistence>");
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  createOmcOrchestratorHook,
  isAllowedPath,
  isSourceFile,
  isWriteEditTool,
  isDelegationTool,
  getEnforcementLevel,
  buildVerificationReminder,
  buildOrchestratorReminder,
  buildBoulderContinuation,
  HOOK_NAME,
  ENFORCEMENT_LEVEL_ENV_VAR,
  DEFAULT_ENFORCEMENT_LEVEL,
} from "../index.js";
import type { HookContext } from "../../hook-types.js";
import {
  createBoulderState,
  writeBoulderState,
} from "../../../lib/boulder-state.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "omcp-orch-test-"));
}

let _counter = 0;
function uniqueSession(label = "orch"): string {
  return `${label}-${Date.now()}-${++_counter}`;
}

function makePreCtx(
  sessionId: string,
  cwd: string,
  toolName: string,
  toolArgs: unknown = {},
): HookContext {
  return { event: "PreToolUse", sessionId, cwd, toolName, toolArgs };
}

function makePostCtx(
  sessionId: string,
  cwd: string,
  toolName: string,
  toolArgs: unknown = {},
  toolResult: unknown = "",
): HookContext {
  return { event: "PostToolUse", sessionId, cwd, toolName, toolArgs, toolResult };
}

// ─── isAllowedPath ────────────────────────────────────────────────────────────

describe("isAllowedPath", () => {
  it("allows .omcp/ relative paths", () => {
    expect(isAllowedPath(".omcp/plans/foo.md")).toBe(true);
  });

  it("allows .claude/ relative paths", () => {
    expect(isAllowedPath(".claude/settings.json")).toBe(true);
  });

  it("allows CLAUDE.md at any depth", () => {
    expect(isAllowedPath("some/nested/CLAUDE.md")).toBe(true);
  });

  it("allows AGENTS.md at any depth", () => {
    expect(isAllowedPath("docs/AGENTS.md")).toBe(true);
  });

  it("rejects source files outside allowed paths", () => {
    expect(isAllowedPath("src/index.ts")).toBe(false);
  });

  it("rejects explicit traversal (../foo)", () => {
    expect(isAllowedPath("../outside.ts")).toBe(false);
  });

  it("resolves absolute paths relative to cwd", () => {
    const cwd = os.tmpdir();
    const allowed = path.join(cwd, ".omcp", "plans", "p.md");
    expect(isAllowedPath(allowed, cwd)).toBe(true);
  });

  it("rejects absolute paths outside cwd", () => {
    const cwd = path.join(os.tmpdir(), "project");
    const outside = path.join(os.tmpdir(), "other", "src.ts");
    expect(isAllowedPath(outside, cwd)).toBe(false);
  });
});

// ─── isSourceFile ─────────────────────────────────────────────────────────────

describe("isSourceFile", () => {
  it("identifies .ts as a source file", () => {
    expect(isSourceFile("src/foo.ts")).toBe(true);
  });

  it("identifies .py as a source file", () => {
    expect(isSourceFile("script.py")).toBe(true);
  });

  it("returns false for empty path", () => {
    expect(isSourceFile("")).toBe(false);
  });

  it("returns false for .md files", () => {
    expect(isSourceFile("README.md")).toBe(false);
  });
});

// ─── isWriteEditTool / isDelegationTool ───────────────────────────────────────

describe("isWriteEditTool", () => {
  it("matches Write", () => expect(isWriteEditTool("Write")).toBe(true));
  it("matches edit (lowercase)", () => expect(isWriteEditTool("edit")).toBe(true));
  it("does not match Read", () => expect(isWriteEditTool("Read")).toBe(false));
});

describe("isDelegationTool", () => {
  it("matches Task", () => expect(isDelegationTool("Task")).toBe(true));
  it("matches agent (lowercase)", () => expect(isDelegationTool("agent")).toBe(true));
  it("does not match Bash", () => expect(isDelegationTool("Bash")).toBe(false));
});

// ─── getEnforcementLevel ──────────────────────────────────────────────────────

describe("getEnforcementLevel", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = tempDir();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("defaults to warn when no config and no env var", () => {
    expect(getEnforcementLevel(cwd)).toBe(DEFAULT_ENFORCEMENT_LEVEL);
  });

  it("respects OMCP_ORCHESTRATOR_ENFORCEMENT env var", () => {
    vi.stubEnv(ENFORCEMENT_LEVEL_ENV_VAR, "strict");
    expect(getEnforcementLevel(cwd)).toBe("strict");
  });

  it("reads from .omcp/config.json when env var absent", () => {
    const cfgDir = path.join(cwd, ".omcp");
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(
      path.join(cfgDir, "config.json"),
      JSON.stringify({ delegationEnforcementLevel: "off" }),
    );
    expect(getEnforcementLevel(cwd)).toBe("off");
  });

  it("env var takes precedence over config file", () => {
    vi.stubEnv(ENFORCEMENT_LEVEL_ENV_VAR, "warn");
    const cfgDir = path.join(cwd, ".omcp");
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(
      path.join(cfgDir, "config.json"),
      JSON.stringify({ delegationEnforcementLevel: "strict" }),
    );
    expect(getEnforcementLevel(cwd)).toBe("warn");
  });
});

// ─── PreToolUse permission decisions ─────────────────────────────────────────

describe("PreToolUse — permission decisions", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = tempDir();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("returns noop when enforcement is off", async () => {
    vi.stubEnv(ENFORCEMENT_LEVEL_ENV_VAR, "off");
    const hook = createOmcOrchestratorHook();
    const result = await hook.run(
      makePreCtx(uniqueSession(), cwd, "Write", { file_path: "src/foo.ts" }),
    );
    expect(result.kind).toBe("noop");
  });

  it("returns noop for non-write tools", async () => {
    vi.stubEnv(ENFORCEMENT_LEVEL_ENV_VAR, "warn");
    const hook = createOmcOrchestratorHook();
    const result = await hook.run(
      makePreCtx(uniqueSession(), cwd, "Bash", { command: "ls" }),
    );
    expect(result.kind).toBe("noop");
  });

  it("returns noop when file is in allowed path (.omcp/)", async () => {
    vi.stubEnv(ENFORCEMENT_LEVEL_ENV_VAR, "warn");
    const hook = createOmcOrchestratorHook();
    const result = await hook.run(
      makePreCtx(uniqueSession(), cwd, "Write", { file_path: ".omcp/plans/task.md" }),
    );
    expect(result.kind).toBe("noop");
  });

  it("returns advise (not block) in warn mode for disallowed path", async () => {
    vi.stubEnv(ENFORCEMENT_LEVEL_ENV_VAR, "warn");
    const hook = createOmcOrchestratorHook();
    const result = await hook.run(
      makePreCtx(uniqueSession(), cwd, "Write", { file_path: "src/app.ts" }),
    );
    expect(result.kind).toBe("advise");
    if (result.kind === "advise") {
      expect(result.text).toContain("DELEGATION REQUIRED");
      expect(result.text).toContain("src/app.ts");
    }
  });

  it("returns block in strict mode for disallowed path", async () => {
    vi.stubEnv(ENFORCEMENT_LEVEL_ENV_VAR, "strict");
    const hook = createOmcOrchestratorHook();
    const result = await hook.run(
      makePreCtx(uniqueSession(), cwd, "Edit", { file_path: "src/utils.ts" }),
    );
    expect(result.kind).toBe("block");
    if (result.kind === "block") {
      expect(result.reason).toContain("DELEGATION REQUIRED");
    }
  });

  it("includes suggested agent in PreToolUse advise text", async () => {
    vi.stubEnv(ENFORCEMENT_LEVEL_ENV_VAR, "warn");
    const hook = createOmcOrchestratorHook();
    const result = await hook.run(
      makePreCtx(uniqueSession(), cwd, "Write", { file_path: "app.ts" }),
    );
    expect(result.kind).toBe("advise");
    if (result.kind === "advise") {
      expect(result.text).toContain("executor");
    }
  });

  it("writes audit log entry when tool is warned", async () => {
    vi.stubEnv(ENFORCEMENT_LEVEL_ENV_VAR, "warn");
    const hook = createOmcOrchestratorHook();
    await hook.run(
      makePreCtx(uniqueSession(), cwd, "Write", { file_path: "src/main.ts" }),
    );
    const logPath = path.join(cwd, ".omcp", "logs", "delegation-audit.jsonl");
    expect(fs.existsSync(logPath)).toBe(true);
    const lines = fs.readFileSync(logPath, "utf-8").trim().split("\n");
    const entry = JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
    expect(entry.decision).toBe("warned");
    expect(entry.tool).toBe("Write");
  });

  it("subscribes to PreToolUse and PostToolUse events", () => {
    const hook = createOmcOrchestratorHook();
    expect(hook.events).toContain("PreToolUse");
    expect(hook.events).toContain("PostToolUse");
    expect(hook.name).toBe(HOOK_NAME);
  });
});

// ─── PostToolUse — modifiedResult / advise paths ──────────────────────────────

describe("PostToolUse — modifiedResult / advise paths", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = tempDir();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("returns modifiedResult with DIRECT_WORK_REMINDER after Write on disallowed path", async () => {
    vi.stubEnv(ENFORCEMENT_LEVEL_ENV_VAR, "warn");
    const hook = createOmcOrchestratorHook();
    const result = await hook.run(
      makePostCtx(uniqueSession(), cwd, "Write", { file_path: "src/index.ts" }, "file written"),
    );
    expect(result.kind).toBe("modifiedResult");
    if (result.kind === "modifiedResult") {
      const text = result.result as string;
      expect(text).toContain("file written");
      expect(text).toContain("DELEGATION REQUIRED");
    }
  });

  it("returns noop after Write on allowed path (.omcp/)", async () => {
    const hook = createOmcOrchestratorHook();
    const result = await hook.run(
      makePostCtx(uniqueSession(), cwd, "Write", { file_path: ".omcp/plans/p.md" }, "written"),
    );
    expect(result.kind).toBe("noop");
  });

  it("returns modifiedResult with verification reminder after Task completes (no boulder)", async () => {
    const hook = createOmcOrchestratorHook();
    const result = await hook.run(
      makePostCtx(uniqueSession(), cwd, "Task", {}, "subagent output here"),
    );
    expect(result.kind).toBe("modifiedResult");
    if (result.kind === "modifiedResult") {
      const text = result.result as string;
      expect(text).toContain("MANDATORY VERIFICATION");
    }
  });

  it("returns modifiedResult with boulder plan progress when boulder is active", async () => {
    const planFile = path.join(cwd, ".omcp", "plans", "my-plan.md");
    fs.mkdirSync(path.dirname(planFile), { recursive: true });
    fs.writeFileSync(planFile, "- [x] done\n- [ ] todo\n");
    const boulder = createBoulderState(planFile, uniqueSession());
    writeBoulderState(boulder, cwd);

    const hook = createOmcOrchestratorHook();
    const result = await hook.run(
      makePostCtx(uniqueSession(), cwd, "Task", {}, "agent output"),
    );
    expect(result.kind).toBe("modifiedResult");
    if (result.kind === "modifiedResult") {
      const text = result.result as string;
      expect(text).toContain("SUBAGENT WORK COMPLETED");
      expect(text).toContain("my-plan");
    }
  });

  it("returns noop for background task launch output", async () => {
    const hook = createOmcOrchestratorHook();
    const result = await hook.run(
      makePostCtx(uniqueSession(), cwd, "Task", {}, "Background task launched"),
    );
    expect(result.kind).toBe("noop");
  });

  it("returns noop for PostToolUse on non-write non-delegation tool", async () => {
    const hook = createOmcOrchestratorHook();
    const result = await hook.run(
      makePostCtx(uniqueSession(), cwd, "Read", {}, "file contents"),
    );
    expect(result.kind).toBe("noop");
  });
});

// ─── No-active-boulder no-op ──────────────────────────────────────────────────

describe("no-active-boulder no-op", () => {
  it("does not inject boulder context when no boulder state exists", async () => {
    const cwd = tempDir();
    const hook = createOmcOrchestratorHook();
    const result = await hook.run(
      makePostCtx(uniqueSession(), cwd, "Task", {}, "done"),
    );
    expect(result.kind).toBe("modifiedResult");
    if (result.kind === "modifiedResult") {
      expect(result.result as string).not.toContain("BOULDER CONTINUATION");
      expect(result.result as string).not.toContain("SUBAGENT WORK COMPLETED");
      expect(result.result as string).toContain("MANDATORY VERIFICATION");
    }
    fs.rmSync(cwd, { recursive: true, force: true });
  });
});

// ─── Message builder unit tests ────────────────────────────────────────────────

describe("buildVerificationReminder", () => {
  it("contains verification text", () => {
    const text = buildVerificationReminder();
    expect(text).toContain("MANDATORY VERIFICATION");
  });

  it("includes session resume hint when sessionId provided", () => {
    const text = buildVerificationReminder("sess-abc");
    expect(text).toContain("sess-abc");
    expect(text).toContain("resume");
  });
});

describe("buildOrchestratorReminder", () => {
  it("includes plan name and progress", () => {
    const text = buildOrchestratorReminder("my-plan", { total: 5, completed: 3 });
    expect(text).toContain("my-plan");
    expect(text).toContain("3/5");
    expect(text).toContain("2 left");
  });
});

describe("buildBoulderContinuation", () => {
  it("includes plan name, remaining, and total", () => {
    const text = buildBoulderContinuation("alpha-plan", 2, 5);
    expect(text).toContain("alpha-plan");
    expect(text).toContain("3/5");
    expect(text).toContain("2 remaining");
  });
});

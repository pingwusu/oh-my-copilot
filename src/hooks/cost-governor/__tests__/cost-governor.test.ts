import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createCostGovernorHook, DEFAULT_BUDGET, BUDGET_ENV_VAR } from "../index.js";
import type { HookContext } from "../../hook-types.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

let _counter = 0;

function uniqueSession(label = "cg"): string {
  return `${label}-${Date.now()}-${++_counter}`;
}

function makeCtx(sessionId: string, cwd: string): HookContext {
  return {
    event: "PermissionRequest",
    sessionId,
    cwd,
  };
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "omcp-cg-test-"));
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("cost-governor", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = tempDir();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    try {
      fs.rmSync(cwd, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it("returns noop when under budget", async () => {
    const hook = createCostGovernorHook();
    const sessionId = uniqueSession();
    const result = await hook.run(makeCtx(sessionId, cwd));
    expect(result).toEqual({ kind: "noop" });
  });

  it("returns interrupt when budget is reached", async () => {
    // Set budget to 1 so the first call hits it
    vi.stubEnv(BUDGET_ENV_VAR, "1");
    const hook = createCostGovernorHook();
    const sessionId = uniqueSession();
    const result = await hook.run(makeCtx(sessionId, cwd));
    expect(result.kind).toBe("interrupt");
    if (result.kind === "interrupt") {
      expect(result.reason).toContain("1");
      expect(result.reason).toContain(BUDGET_ENV_VAR);
    }
  });

  it("respects custom budget via env var", async () => {
    vi.stubEnv(BUDGET_ENV_VAR, "3");
    const hook = createCostGovernorHook();
    const sessionId = uniqueSession();

    // Calls 1 and 2 should be noop
    const r1 = await hook.run(makeCtx(sessionId, cwd));
    const r2 = await hook.run(makeCtx(sessionId, cwd));
    expect(r1).toEqual({ kind: "noop" });
    expect(r2).toEqual({ kind: "noop" });

    // Call 3 hits budget
    const r3 = await hook.run(makeCtx(sessionId, cwd));
    expect(r3.kind).toBe("interrupt");
  });

  it("isolates state per session (different sessionIds have independent counters)", async () => {
    vi.stubEnv(BUDGET_ENV_VAR, "2");
    const hook = createCostGovernorHook();
    const sessionA = uniqueSession("cgA");
    const sessionB = uniqueSession("cgB");

    // Exhaust sessionA
    await hook.run(makeCtx(sessionA, cwd));
    const rA = await hook.run(makeCtx(sessionA, cwd));
    expect(rA.kind).toBe("interrupt");

    // sessionB is still fresh
    const rB = await hook.run(makeCtx(sessionB, cwd));
    expect(rB).toEqual({ kind: "noop" });
  });

  it("persists state across hook instances (simulates short-lived processes)", async () => {
    vi.stubEnv(BUDGET_ENV_VAR, "3");
    const sessionId = uniqueSession();

    // First hook instance fires twice
    const hook1 = createCostGovernorHook();
    await hook1.run(makeCtx(sessionId, cwd));
    await hook1.run(makeCtx(sessionId, cwd));

    // Second hook instance (fresh in-memory state) reads from disk
    const hook2 = createCostGovernorHook();
    const result = await hook2.run(makeCtx(sessionId, cwd));
    expect(result.kind).toBe("interrupt");
  });

  it("rejects path-traversal sessionId via assertSafeSlug", async () => {
    const hook = createCostGovernorHook();
    await expect(
      hook.run({
        event: "PermissionRequest",
        sessionId: "../escape",
        cwd,
      }),
    ).rejects.toThrow("unsafe");
  });

  it("state file contains valid JSON after write (atomic write invariant)", async () => {
    const hook = createCostGovernorHook();
    const sessionId = uniqueSession();
    await hook.run(makeCtx(sessionId, cwd));

    const stateFile = path.join(cwd, ".omcp", "state", "cost-governor", `${sessionId}.json`);
    expect(fs.existsSync(stateFile)).toBe(true);
    const content = fs.readFileSync(stateFile, "utf-8");
    expect(() => JSON.parse(content)).not.toThrow();
    const parsed = JSON.parse(content) as { count: number };
    expect(parsed.count).toBe(1);
  });

  it("subscribes to PermissionRequest event", () => {
    const hook = createCostGovernorHook();
    expect(hook.events).toContain("PermissionRequest");
    expect(hook.name).toBe("cost-governor");
  });

  it("DEFAULT_BUDGET is 1000", () => {
    expect(DEFAULT_BUDGET).toBe(1000);
  });
});

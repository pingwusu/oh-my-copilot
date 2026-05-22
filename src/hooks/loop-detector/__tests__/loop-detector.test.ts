import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  createLoopDetectorHook,
  buildSignature,
  stableHashOf,
  stableJson,
  DEFAULT_THRESHOLD,
  DEFAULT_WINDOW,
  THRESHOLD_ENV_VAR,
  WINDOW_ENV_VAR,
} from "../index.js";
import type { HookContext } from "../../hook-types.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

let _counter = 0;

function uniqueSession(label = "ld"): string {
  return `${label}-${Date.now()}-${++_counter}`;
}

function makeCtx(
  sessionId: string,
  cwd: string,
  toolName: string,
  toolArgs: unknown,
): HookContext {
  return {
    event: "PreToolUse",
    sessionId,
    cwd,
    toolName,
    toolArgs,
  };
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "omcp-ld-test-"));
}

// ─── stableJson / stableHashOf ────────────────────────────────────────────────

describe("stableJson", () => {
  it("produces the same output regardless of key order", () => {
    const a = stableJson({ a: 1, b: 2 });
    const b = stableJson({ b: 2, a: 1 });
    expect(a).toBe(b);
  });

  it("handles nested objects with unsorted keys", () => {
    const a = stableJson({ z: { y: 1, x: 2 }, m: 3 });
    const b = stableJson({ m: 3, z: { x: 2, y: 1 } });
    expect(a).toBe(b);
  });

  it("handles arrays (order preserved)", () => {
    expect(stableJson([1, 2, 3])).toBe("[1,2,3]");
  });

  it("handles null and primitives", () => {
    expect(stableJson(null)).toBe("null");
    expect(stableJson(42)).toBe("42");
    expect(stableJson("hi")).toBe('"hi"');
  });
});

describe("stableHashOf", () => {
  it("produces same 12-char hash for equivalent arg objects", () => {
    const h1 = stableHashOf({ a: 1, b: 2 });
    const h2 = stableHashOf({ b: 2, a: 1 });
    expect(h1).toBe(h2);
    expect(h1).toHaveLength(12);
  });

  it("produces different hashes for different args", () => {
    expect(stableHashOf({ a: 1 })).not.toBe(stableHashOf({ a: 2 }));
  });
});

describe("buildSignature", () => {
  it("combines toolName and hash with :: separator", () => {
    const sig = buildSignature("bash", { cmd: "ls" });
    expect(sig).toMatch(/^bash::[0-9a-f]{12}$/);
  });

  it("key-order independence: {a:1,b:2} and {b:2,a:1} produce same signature", () => {
    const s1 = buildSignature("read", { a: 1, b: 2 });
    const s2 = buildSignature("read", { b: 2, a: 1 });
    expect(s1).toBe(s2);
  });
});

// ─── createLoopDetectorHook ───────────────────────────────────────────────────

describe("createLoopDetectorHook", () => {
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
      // ignore
    }
  });

  it("subscribes to PreToolUse and has name 'loop-detector'", () => {
    const hook = createLoopDetectorHook();
    expect(hook.events).toContain("PreToolUse");
    expect(hook.name).toBe("loop-detector");
  });

  it("returns noop when 5 different tools are called in a row", async () => {
    const hook = createLoopDetectorHook();
    const sessionId = uniqueSession();
    const tools = ["bash", "read", "glob", "grep", "edit"];
    for (const tool of tools) {
      const result = await hook.run(makeCtx(sessionId, cwd, tool, { file: tool }));
      expect(result).toEqual({ kind: "noop" });
    }
  });

  it("returns interrupt after threshold identical calls", async () => {
    // Default threshold is 5
    const hook = createLoopDetectorHook();
    const sessionId = uniqueSession();
    const args = { file: "foo.ts" };

    let lastResult = { kind: "noop" } as Awaited<ReturnType<typeof hook.run>>;
    for (let i = 0; i < DEFAULT_THRESHOLD; i++) {
      lastResult = await hook.run(makeCtx(sessionId, cwd, "read", args));
    }
    expect(lastResult.kind).toBe("interrupt");
    if (lastResult.kind === "interrupt") {
      expect(lastResult.reason).toContain("read");
      expect(lastResult.reason).toContain(String(DEFAULT_THRESHOLD));
    }
  });

  it("key-order independence: {a:1,b:2} and {b:2,a:1} count as the same call", async () => {
    vi.stubEnv(THRESHOLD_ENV_VAR, "4");
    const hook = createLoopDetectorHook();
    const sessionId = uniqueSession();

    // Alternate key order but semantically identical
    for (let i = 0; i < 2; i++) {
      await hook.run(makeCtx(sessionId, cwd, "bash", { a: 1, b: 2 }));
      await hook.run(makeCtx(sessionId, cwd, "bash", { b: 2, a: 1 }));
    }
    // 4 semantically identical calls → interrupt
    const result = await hook.run(makeCtx(sessionId, cwd, "bash", { a: 1, b: 2 }));
    expect(result.kind).toBe("interrupt");
  });

  it("window-rolloff: 5 identical calls at front evicted by 6 new calls → noop", async () => {
    // Window size 10, threshold 5. Put 5 identical calls first, then 6 different calls.
    // The 5 identical calls are evicted from the window; the current new call
    // appears only once → noop.
    vi.stubEnv(WINDOW_ENV_VAR, "10");
    vi.stubEnv(THRESHOLD_ENV_VAR, "5");
    const hook = createLoopDetectorHook();
    const sessionId = uniqueSession();

    // 5 identical calls (fills half the window)
    for (let i = 0; i < 5; i++) {
      await hook.run(makeCtx(sessionId, cwd, "read", { file: "same.ts" }));
    }

    // 6 different calls to push them out (window is now 10 entries, all different from "read/same.ts")
    for (let i = 0; i < 6; i++) {
      await hook.run(makeCtx(sessionId, cwd, "write", { file: `other-${i}.ts` }));
    }

    // Now "read/same.ts" should no longer be in window at all
    const result = await hook.run(makeCtx(sessionId, cwd, "read", { file: "same.ts" }));
    // This is the first occurrence of that signature in the current window
    expect(result).toEqual({ kind: "noop" });
  });

  it("respects custom threshold via env var", async () => {
    vi.stubEnv(THRESHOLD_ENV_VAR, "2");
    const hook = createLoopDetectorHook();
    const sessionId = uniqueSession();
    const args = { x: 1 };

    await hook.run(makeCtx(sessionId, cwd, "bash", args));
    const result = await hook.run(makeCtx(sessionId, cwd, "bash", args));
    expect(result.kind).toBe("interrupt");
  });

  it("isolates state per session", async () => {
    vi.stubEnv(THRESHOLD_ENV_VAR, "3");
    const hook = createLoopDetectorHook();
    const sessionA = uniqueSession("ldA");
    const sessionB = uniqueSession("ldB");
    const args = { file: "test.ts" };

    // Exhaust sessionA
    for (let i = 0; i < 3; i++) {
      await hook.run(makeCtx(sessionA, cwd, "read", args));
    }
    const rA = await hook.run(makeCtx(sessionA, cwd, "read", args));
    expect(rA.kind).toBe("interrupt");

    // sessionB is fresh
    const rB = await hook.run(makeCtx(sessionB, cwd, "read", args));
    expect(rB).toEqual({ kind: "noop" });
  });

  it("DEFAULT_THRESHOLD is 5 and DEFAULT_WINDOW is 10", () => {
    expect(DEFAULT_THRESHOLD).toBe(5);
    expect(DEFAULT_WINDOW).toBe(10);
  });
});

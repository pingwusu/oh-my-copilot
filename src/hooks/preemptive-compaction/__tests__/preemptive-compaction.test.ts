import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  estimateTokens,
  analyzeContextUsage,
  createPreemptiveCompactionHook,
  resetSessionTokenEstimate,
  clearRapidFireDebounce,
  RAPID_FIRE_DEBOUNCE_MS,
} from "../index.js";
import {
  DEFAULT_THRESHOLD,
  CRITICAL_THRESHOLD,
  COMPACTION_COOLDOWN_MS,
  MAX_WARNINGS,
  CLAUDE_DEFAULT_CONTEXT_LIMIT,
  CHARS_PER_TOKEN,
  CONTEXT_WARNING_MESSAGE,
  CONTEXT_CRITICAL_MESSAGE,
} from "../constants.js";
import type { HookContext } from "../../hook-types.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

let _sessionCounter = 0;

/** Generate a unique session ID per test to avoid module-level Map pollution. */
function uniqueSession(label = "t"): string {
  return `${label}-${Date.now()}-${++_sessionCounter}`;
}

function makeCtx(
  overrides: Partial<HookContext> & { event: HookContext["event"] },
): HookContext {
  return {
    sessionId: "test-session-1",
    cwd: process.cwd(),
    ...overrides,
  };
}

/** Build a string whose token estimate is `targetRatio * CLAUDE_DEFAULT_CONTEXT_LIMIT`. */
function contentAtRatio(ratio: number): string {
  const targetTokens = Math.ceil(ratio * CLAUDE_DEFAULT_CONTEXT_LIMIT);
  return "x".repeat(targetTokens * CHARS_PER_TOKEN);
}

// ─── estimateTokens ───────────────────────────────────────────────────────────

describe("estimateTokens", () => {
  it("returns ceil(length / CHARS_PER_TOKEN)", () => {
    expect(estimateTokens("abcd")).toBe(1); // 4 chars / 4 = 1
    expect(estimateTokens("abcde")).toBe(2); // 5 chars / 4 = 1.25 → ceil = 2
    expect(estimateTokens("")).toBe(0);
  });
});

// ─── analyzeContextUsage ──────────────────────────────────────────────────────

describe("analyzeContextUsage", () => {
  it("returns action=none below warning threshold", () => {
    const result = analyzeContextUsage(contentAtRatio(0.5));
    expect(result.isWarning).toBe(false);
    expect(result.isCritical).toBe(false);
    expect(result.action).toBe("none");
  });

  it("returns action=warn between DEFAULT_THRESHOLD and CRITICAL_THRESHOLD", () => {
    const ratio = (DEFAULT_THRESHOLD + CRITICAL_THRESHOLD) / 2;
    const result = analyzeContextUsage(contentAtRatio(ratio));
    expect(result.isWarning).toBe(true);
    expect(result.isCritical).toBe(false);
    expect(result.action).toBe("warn");
  });

  it("returns action=compact at or above CRITICAL_THRESHOLD", () => {
    const result = analyzeContextUsage(contentAtRatio(CRITICAL_THRESHOLD + 0.01));
    expect(result.isWarning).toBe(true);
    expect(result.isCritical).toBe(true);
    expect(result.action).toBe("compact");
  });

  it("respects custom warningThreshold config", () => {
    const result = analyzeContextUsage(contentAtRatio(0.7), {
      warningThreshold: 0.6,
      criticalThreshold: 0.99,
    });
    expect(result.isWarning).toBe(true);
    expect(result.isCritical).toBe(false);
  });
});

// ─── createPreemptiveCompactionHook ──────────────────────────────────────────

describe("createPreemptiveCompactionHook", () => {
  const SESSION = "hook-test-session";
  const CWD = process.cwd();

  // Use a config with a very low token threshold so we can trigger warnings
  // cheaply, plus very short cooldown for cooldown-lapsed test.
  const WARN_RATIO = 0.001; // triggers at ~200 tokens in default 200k context
  const baseConfig = {
    warningThreshold: WARN_RATIO,
    criticalThreshold: 0.999, // essentially never critical in these tests
    cooldownMs: 100,
    maxWarnings: MAX_WARNINGS,
  };

  beforeEach(() => {
    resetSessionTokenEstimate(SESSION);
    clearRapidFireDebounce(SESSION);
    vi.useFakeTimers();
  });

  afterEach(() => {
    resetSessionTokenEstimate(SESSION);
    clearRapidFireDebounce(SESSION);
    vi.useRealTimers();
  });

  // ── Registration ────────────────────────────────────────────────────────────

  it("subscribes to PostToolUse and PreCompact events", () => {
    const hook = createPreemptiveCompactionHook();
    expect(hook.events).toContain("PostToolUse");
    expect(hook.events).toContain("PreCompact");
  });

  it("has name 'preemptive-compaction'", () => {
    const hook = createPreemptiveCompactionHook();
    expect(hook.name).toBe("preemptive-compaction");
  });

  // ── enabled=false ────────────────────────────────────────────────────────────

  it("returns noop when config.enabled is false", async () => {
    const hook = createPreemptiveCompactionHook({ enabled: false });
    const result = await hook.run(
      makeCtx({
        event: "PostToolUse",
        sessionId: SESSION,
        cwd: CWD,
        toolName: "read",
        toolResult: contentAtRatio(WARN_RATIO + 0.05),
      }),
    );
    expect(result).toEqual({ kind: "noop" });
  });

  // ── Under-threshold → noop ────────────────────────────────────────────────

  it("returns noop when token estimate is below warning threshold", async () => {
    const hook = createPreemptiveCompactionHook({
      warningThreshold: 0.99, // almost impossible to hit
    });
    const result = await hook.run(
      makeCtx({
        event: "PostToolUse",
        sessionId: SESSION,
        cwd: CWD,
        toolName: "read",
        toolResult: "small content",
      }),
    );
    expect(result).toEqual({ kind: "noop" });
  });

  // ── Tool filter ──────────────────────────────────────────────────────────────

  it("returns noop for tools not in LARGE_OUTPUT_TOOLS list", async () => {
    const hook = createPreemptiveCompactionHook(baseConfig);
    const result = await hook.run(
      makeCtx({
        event: "PostToolUse",
        sessionId: SESSION,
        cwd: CWD,
        toolName: "Edit", // not in the large-output list
        toolResult: contentAtRatio(WARN_RATIO + 0.1),
      }),
    );
    expect(result).toEqual({ kind: "noop" });
  });

  // ── Over DEFAULT_THRESHOLD → advise with warning message ─────────────────

  it("returns advise with warning message when above warning threshold", async () => {
    const hook = createPreemptiveCompactionHook(baseConfig);
    // Provide a big enough payload to breach WARN_RATIO
    const bigPayload = contentAtRatio(WARN_RATIO + 0.1);
    const result = await hook.run(
      makeCtx({
        event: "PostToolUse",
        sessionId: SESSION,
        cwd: CWD,
        toolName: "bash",
        toolResult: bigPayload,
      }),
    );
    expect(result.kind).toBe("advise");
    if (result.kind === "advise") {
      expect(result.text).toBe(CONTEXT_WARNING_MESSAGE);
    }
  });

  // ── Over CRITICAL_THRESHOLD → advise with critical message ───────────────

  it("returns advise with critical message when above critical threshold", async () => {
    const hook = createPreemptiveCompactionHook({
      ...baseConfig,
      warningThreshold: 0.001,
      criticalThreshold: 0.001, // both thresholds very low so critical fires
    });
    const bigPayload = contentAtRatio(0.05);
    const result = await hook.run(
      makeCtx({
        event: "PostToolUse",
        sessionId: SESSION,
        cwd: CWD,
        toolName: "bash",
        toolResult: bigPayload,
      }),
    );
    expect(result.kind).toBe("advise");
    if (result.kind === "advise") {
      expect(result.text).toBe(CONTEXT_CRITICAL_MESSAGE);
    }
  });

  // ── Cooldown enforced ────────────────────────────────────────────────────

  it("returns noop on second fire within cooldown window", async () => {
    const hook = createPreemptiveCompactionHook({
      ...baseConfig,
      cooldownMs: 60_000,
    });
    const bigPayload = contentAtRatio(WARN_RATIO + 0.1);
    const ctx = makeCtx({
      event: "PostToolUse",
      sessionId: SESSION,
      cwd: CWD,
      toolName: "bash",
      toolResult: bigPayload,
    });

    // First fire — should warn
    const first = await hook.run(ctx);
    expect(first.kind).toBe("advise");

    // Advance time by less than cooldown (rapid-fire debounce is 500ms; skip past it)
    vi.advanceTimersByTime(RAPID_FIRE_DEBOUNCE_MS + 10);
    clearRapidFireDebounce(SESSION);

    // Second fire within cooldown — should noop
    const second = await hook.run(ctx);
    expect(second).toEqual({ kind: "noop" });
  });

  // ── Cooldown lapsed → advise again ──────────────────────────────────────

  it("returns advise again after cooldown period has lapsed", async () => {
    const SHORT_COOLDOWN = 200;
    const hook = createPreemptiveCompactionHook({
      ...baseConfig,
      cooldownMs: SHORT_COOLDOWN,
    });
    const bigPayload = contentAtRatio(WARN_RATIO + 0.1);
    const ctx = makeCtx({
      event: "PostToolUse",
      sessionId: SESSION,
      cwd: CWD,
      toolName: "bash",
      toolResult: bigPayload,
    });

    // First fire
    const first = await hook.run(ctx);
    expect(first.kind).toBe("advise");

    // Advance past cooldown AND debounce window
    vi.advanceTimersByTime(SHORT_COOLDOWN + RAPID_FIRE_DEBOUNCE_MS + 50);
    clearRapidFireDebounce(SESSION);

    // Second fire after cooldown — should advise again
    const second = await hook.run(ctx);
    expect(second.kind).toBe("advise");
  });

  // ── MAX_WARNINGS respected ───────────────────────────────────────────────

  it("stops warning after MAX_WARNINGS firings", async () => {
    const SHORT_COOLDOWN = 1; // 1ms so we can fire many times quickly
    const hook = createPreemptiveCompactionHook({
      ...baseConfig,
      cooldownMs: SHORT_COOLDOWN,
      maxWarnings: 2,
    });
    const bigPayload = contentAtRatio(WARN_RATIO + 0.1);

    for (let i = 0; i < 2; i++) {
      // Advance past cooldown and debounce for each iteration
      vi.advanceTimersByTime(SHORT_COOLDOWN + RAPID_FIRE_DEBOUNCE_MS + 50);
      clearRapidFireDebounce(SESSION);
      const result = await hook.run(
        makeCtx({
          event: "PostToolUse",
          sessionId: SESSION,
          cwd: CWD,
          toolName: "bash",
          toolResult: bigPayload,
        }),
      );
      expect(result.kind).toBe("advise");
    }

    // One more advance then fire — should be noop (max reached)
    vi.advanceTimersByTime(SHORT_COOLDOWN + RAPID_FIRE_DEBOUNCE_MS + 50);
    clearRapidFireDebounce(SESSION);
    const final = await hook.run(
      makeCtx({
        event: "PostToolUse",
        sessionId: SESSION,
        cwd: CWD,
        toolName: "bash",
        toolResult: bigPayload,
      }),
    );
    expect(final).toEqual({ kind: "noop" });
  });

  // ── PreCompact event triggers same logic ─────────────────────────────────

  it("PreCompact event triggers the same warning logic", async () => {
    // Use a unique session ID so module-level Map state from other tests
    // in the full suite never pollutes this test.
    const SESSION_PC = uniqueSession("precompact");

    const hook = createPreemptiveCompactionHook({
      warningThreshold: 0.001,
      criticalThreshold: 0.999,
      cooldownMs: 1,
      maxWarnings: MAX_WARNINGS,
    });

    // Seed tokens by running PostToolUse — this also triggers warning #1.
    // We want PreCompact to trigger warning #2 after cooldown lapses.
    const bigPayload = contentAtRatio(0.05);
    const firstResult = await hook.run(
      makeCtx({
        event: "PostToolUse",
        sessionId: SESSION_PC,
        cwd: CWD,
        toolName: "bash",
        toolResult: bigPayload,
      }),
    );
    expect(firstResult.kind).toBe("advise"); // warning #1 confirmed

    // Advance past cooldown (1ms) and debounce (500ms)
    vi.advanceTimersByTime(RAPID_FIRE_DEBOUNCE_MS + 100);
    clearRapidFireDebounce(SESSION_PC);

    // PreCompact on the same session: tokens still accumulated, cooldown lapsed
    const result = await hook.run(
      makeCtx({
        event: "PreCompact",
        sessionId: SESSION_PC,
        cwd: CWD,
      }),
    );
    expect(result.kind).toBe("advise");

    resetSessionTokenEstimate(SESSION_PC);
    clearRapidFireDebounce(SESSION_PC);
  });

  // ── PostToolUse and PreCompact are both in events list ───────────────────

  it("both PostToolUse and PreCompact events are subscribed", async () => {
    const hook = createPreemptiveCompactionHook(baseConfig);
    // PostToolUse with a tool not in LARGE_OUTPUT_TOOLS but event is subscribed
    const postResult = await hook.run(
      makeCtx({
        event: "PostToolUse",
        sessionId: SESSION,
        cwd: CWD,
        toolName: "Write",
        toolResult: "small",
      }),
    );
    // Write is not in LARGE_OUTPUT_TOOLS so noop, but it ran (didn't throw)
    expect(postResult).toEqual({ kind: "noop" });

    const preCompactResult = await hook.run(
      makeCtx({
        event: "PreCompact",
        sessionId: SESSION,
        cwd: CWD,
      }),
    );
    // No tokens accumulated above threshold yet
    expect(preCompactResult).toEqual({ kind: "noop" });
  });

  // ── customMessage config ─────────────────────────────────────────────────

  it("uses customMessage when provided in config", async () => {
    const customMsg = "CUSTOM: please compact now";
    const hook = createPreemptiveCompactionHook({
      ...baseConfig,
      customMessage: customMsg,
    });
    const bigPayload = contentAtRatio(WARN_RATIO + 0.1);
    const result = await hook.run(
      makeCtx({
        event: "PostToolUse",
        sessionId: SESSION,
        cwd: CWD,
        toolName: "bash",
        toolResult: bigPayload,
      }),
    );
    expect(result.kind).toBe("advise");
    if (result.kind === "advise") {
      expect(result.text).toBe(customMsg);
    }
  });

  // ── Rapid-fire debounce ──────────────────────────────────────────────────

  it("rapid-fire debounce: second PostToolUse within debounce window returns noop", async () => {
    const hook = createPreemptiveCompactionHook(baseConfig);
    const bigPayload = contentAtRatio(WARN_RATIO + 0.1);
    const ctx = makeCtx({
      event: "PostToolUse",
      sessionId: SESSION,
      cwd: CWD,
      toolName: "bash",
      toolResult: bigPayload,
    });

    // First call records analysis time
    const first = await hook.run(ctx);
    expect(first.kind).toBe("advise");

    // Advance time to just inside the debounce window but past cooldown
    vi.advanceTimersByTime(RAPID_FIRE_DEBOUNCE_MS - 10);

    // Second call within debounce window — noop regardless of cooldown state
    const second = await hook.run(ctx);
    expect(second).toEqual({ kind: "noop" });
  });

  // ── missing toolResult → noop ────────────────────────────────────────────

  it("returns noop when PostToolUse has no toolResult", async () => {
    const hook = createPreemptiveCompactionHook(baseConfig);
    const result = await hook.run(
      makeCtx({
        event: "PostToolUse",
        sessionId: SESSION,
        cwd: CWD,
        toolName: "bash",
        // toolResult intentionally absent
      }),
    );
    expect(result).toEqual({ kind: "noop" });
  });
});

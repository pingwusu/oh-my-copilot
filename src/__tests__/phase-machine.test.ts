import { describe, expect, it } from "vitest";
import type { AutopilotState, RalphLoopState } from "../runtime/mode-state.js";
import {
  DEFAULT_LOOPBACK_CAP,
  transitionAutopilot,
  transitionRalphToUltraQA,
} from "../runtime/phase-machine.js";

function makeAutopilot(
  overrides: Partial<AutopilotState> = {},
): AutopilotState {
  return {
    active: true,
    session_id: "s1",
    started_at: "2026-05-18T00:00:00.000Z",
    phase: "expansion",
    iteration: 0,
    ralph_iterations: 0,
    ultraqa_cycles: 0,
    ...overrides,
  };
}

describe("transitionAutopilot", () => {
  it("accepts the full forward chain expansion→planning→execution→qa→validation→cleanup", () => {
    let ctx = makeAutopilot();
    const steps: Array<[AutopilotState["phase"], AutopilotState["phase"]]> = [
      ["expansion", "planning"],
      ["planning", "execution"],
      ["execution", "qa"],
      ["qa", "validation"],
      ["validation", "cleanup"],
    ];
    for (const [from, to] of steps) {
      const r = transitionAutopilot(from, to, ctx);
      expect(r.ok, `${from}→${to}`).toBe(true);
      expect(r.next?.phase).toBe(to);
      ctx = r.next as AutopilotState;
    }
    expect(ctx.iteration).toBe(5);
  });

  it("rejects illegal jumps (expansion→execution, planning→cleanup, cleanup→anything)", () => {
    expect(
      transitionAutopilot("expansion", "execution", makeAutopilot()).ok,
    ).toBe(false);
    expect(
      transitionAutopilot(
        "planning",
        "cleanup",
        makeAutopilot({ phase: "planning" }),
      ).ok,
    ).toBe(false);
    expect(
      transitionAutopilot(
        "cleanup",
        "expansion",
        makeAutopilot({ phase: "cleanup" }),
      ).ok,
    ).toBe(false);
  });

  it("rejects when ctx.phase does not match `from`", () => {
    const ctx = makeAutopilot({ phase: "execution" });
    const r = transitionAutopilot("planning", "execution", ctx);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/phase mismatch/);
  });

  it("allows execution↔qa loopback and increments counters", () => {
    let ctx = makeAutopilot({ phase: "execution", iteration: 2 });
    const r1 = transitionAutopilot("execution", "qa", ctx);
    expect(r1.ok).toBe(true);
    expect(r1.next?.ralph_iterations).toBe(1);
    expect(r1.next?.phase).toBe("qa");
    expect(r1.next?.iteration).toBe(3);
    ctx = r1.next as AutopilotState;

    const r2 = transitionAutopilot("qa", "execution", ctx);
    expect(r2.ok).toBe(true);
    expect(r2.next?.ultraqa_cycles).toBe(1);
    expect(r2.next?.phase).toBe("execution");
  });

  it("blocks loopback once cap is exceeded", () => {
    let ctx = makeAutopilot({
      phase: "execution",
      ralph_iterations: DEFAULT_LOOPBACK_CAP,
    });
    const r = transitionAutopilot("execution", "qa", ctx, {
      loopbackCap: DEFAULT_LOOPBACK_CAP,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/exceeded cap/);

    ctx = makeAutopilot({ phase: "qa", ultraqa_cycles: 2 });
    const r2 = transitionAutopilot("qa", "execution", ctx, {
      loopbackCap: 2,
    });
    expect(r2.ok).toBe(false);
    expect(r2.reason).toMatch(/exceeded cap/);
  });

  it("respects a custom loopback cap", () => {
    const ctx = makeAutopilot({
      phase: "execution",
      ralph_iterations: 0,
    });
    const r = transitionAutopilot("execution", "qa", ctx, { loopbackCap: 1 });
    expect(r.ok).toBe(true);
    const r2 = transitionAutopilot("execution", "qa", r.next as AutopilotState, {
      loopbackCap: 1,
    });
    expect(r2.ok).toBe(false);
  });
});

describe("transitionRalphToUltraQA", () => {
  function makeRalph(overrides: Partial<RalphLoopState> = {}): RalphLoopState {
    return {
      active: true,
      session_id: "ralph-1",
      started_at: "2026-05-18T00:00:00.000Z",
      iteration: 3,
      max_iterations: 10,
      prompt: "fix bug",
      ...overrides,
    };
  }

  it("hands off when ralph is active with iterations > 0", () => {
    const r = transitionRalphToUltraQA(makeRalph(), { max_cycles: 4 });
    expect(r.ok).toBe(true);
    expect(r.next?.cycle).toBe(1);
    expect(r.next?.max_cycles).toBe(4);
    expect(r.next?.source_mode).toBe("ralph");
    expect(r.next?.source_session_id).toBe("ralph-1");
    expect(r.next?.prompt).toBe("fix bug");
  });

  it("rejects when ralph is inactive or has run zero iterations", () => {
    expect(
      transitionRalphToUltraQA(makeRalph({ active: false }), {}).ok,
    ).toBe(false);
    expect(
      transitionRalphToUltraQA(makeRalph({ iteration: 0 }), {}).ok,
    ).toBe(false);
  });

  it("rejects non-positive max_cycles", () => {
    const r = transitionRalphToUltraQA(makeRalph(), { max_cycles: 0 });
    expect(r.ok).toBe(false);
  });
});

/**
 * Deterministic integration test: Stop hook handler advances ralph iteration
 * when fed Copilot's actual snake_case Stop payload.
 *
 * Background (v1.4 RCA, docs/upstream-reports/stop-hook-handler-exit-1-investigation.md):
 *
 * Copilot's Stop event payload uses snake_case fields:
 *   {
 *     "hook_event_name": "Stop",
 *     "session_id": "<uuid>",
 *     "timestamp": "<iso>",
 *     "cwd": "<abs>",
 *     "transcript_path": "<abs>",
 *     "stop_reason": "end_turn"
 *   }
 *
 * Pre-v1.4, omcp's runFireCli read only `sessionId` (camelCase) — the
 * resulting `ctx.sessionId` was always "". Worse, `extractStopContext`
 * read `ctx.toolArgs ?? ctx.toolResult` which Copilot does NOT populate
 * for Stop events, returning an empty StopContext. This was non-fatal but
 * left bail-out guards (isContextLimitStop, isRateLimitStop, ...) blind to
 * the real stop_reason.
 *
 * The v1.4 fix:
 *   - HookContext gains an optional `payload?: Record<string, unknown>`
 *     field carrying the raw stdin payload (snake_case preserved).
 *   - runFireCli accepts both `sessionId` and `session_id` for sessionId
 *     extraction, and populates `ctx.payload` from the full stdin object.
 *   - extractStopContext reads from `ctx.payload` first, falling back to
 *     `toolArgs`/`toolResult` for legacy hosts.
 *
 * This test verifies the end-to-end Stop → ralph iteration-advance path
 * with the canonical Copilot snake_case payload. It would have caught the
 * regression silently if it had existed before v1.4.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createPersistentModeHook } from "../hooks/persistent-mode/index.js";
import { readRalphState, writeRalphState } from "../lib/ralph-state.js";
import type { HookContext } from "../hooks/hook-types.js";
import type { RalphState } from "../lib/ralph-state.js";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "omcp-stop-iter-"));
  mkdirSync(join(dir, ".omcp", "state"), { recursive: true });
  return dir;
}

function seedActiveRalph(cwd: string, iteration: number): RalphState {
  const state: RalphState = {
    active: true,
    iteration,
    lastFiredAt: new Date().toISOString(),
    prompt: "implement stories",
  };
  writeRalphState(state, cwd);
  return state;
}

/** Mimics what runFireCli now produces from Copilot's snake_case Stop emit. */
function makeStopCtxFromCopilotPayload(cwd: string): HookContext {
  const payload: Record<string, unknown> = {
    hook_event_name: "Stop",
    session_id: "c87cb78f-e572-49cd-8851-029792f68513",
    timestamp: "2026-05-24T09:14:39.328Z",
    cwd,
    transcript_path: join(
      cwd,
      ".copilot",
      "session-state",
      "c87cb78f-e572-49cd-8851-029792f68513",
      "events.jsonl",
    ),
    stop_reason: "end_turn",
  };
  return {
    event: "Stop",
    sessionId: payload.session_id as string,
    cwd,
    payload,
  };
}

// ── setup / teardown ─────────────────────────────────────────────────────────

let tmp: string;
let hook: ReturnType<typeof createPersistentModeHook>;

beforeEach(() => {
  tmp = makeTmp();
  hook = createPersistentModeHook();
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// ── tests ────────────────────────────────────────────────────────────────────

describe("Stop hook → ralph iteration advancement (v1.4 RCA — Copilot snake_case payload)", () => {
  it("active ralph + end_turn stop → iteration advances 1→2 and result is advise (continuation)", async () => {
    seedActiveRalph(tmp, 1);

    const ctx = makeStopCtxFromCopilotPayload(tmp);
    const result = await hook.run(ctx);

    expect(result.kind).toBe("advise");
    const post = readRalphState(tmp);
    expect(post).not.toBeNull();
    expect(post!.iteration).toBe(2);
  });

  it("active ralph at iteration 3 + end_turn → iteration advances to 4", async () => {
    seedActiveRalph(tmp, 3);

    const ctx = makeStopCtxFromCopilotPayload(tmp);
    const result = await hook.run(ctx);

    expect(result.kind).toBe("advise");
    expect(readRalphState(tmp)!.iteration).toBe(4);
  });

  it("active ralph + context_limit stop_reason → noop (no iteration advance — bail-out guard fires)", async () => {
    seedActiveRalph(tmp, 1);

    const ctx = makeStopCtxFromCopilotPayload(tmp);
    // Override stop_reason to context_limit; isContextLimitStop must read it.
    (ctx.payload as Record<string, unknown>).stop_reason = "context_limit_exceeded";

    const result = await hook.run(ctx);

    expect(result.kind).toBe("noop");
    // Iteration should NOT advance when bail-out guard fires.
    expect(readRalphState(tmp)!.iteration).toBe(1);
  });

  it("active ralph + PRD all complete → clears state (noop) instead of advancing", async () => {
    seedActiveRalph(tmp, 2);
    // Write a complete PRD so the PRD-complete branch fires before increment.
    writeFileSync(
      join(tmp, ".omcp", "prd.json"),
      JSON.stringify(
        {
          project: "test",
          branchName: "main",
          description: "x",
          userStories: [
            {
              id: "US-001",
              title: "S1",
              description: "d",
              acceptanceCriteria: ["a"],
              priority: 1,
              passes: true,
            },
          ],
        },
        null,
        2,
      ),
    );

    const ctx = makeStopCtxFromCopilotPayload(tmp);
    const result = await hook.run(ctx);

    expect(result.kind).toBe("noop");
    expect(readRalphState(tmp)).toBeNull();
  });

  it("payload-less ctx (legacy / non-Copilot host) still works via toolArgs fallback", async () => {
    seedActiveRalph(tmp, 1);

    // No payload — extractStopContext falls back to toolArgs ?? toolResult.
    const ctx: HookContext = {
      event: "Stop",
      sessionId: "legacy-session",
      cwd: tmp,
      toolArgs: { stop_reason: "end_turn" },
    };
    const result = await hook.run(ctx);

    expect(result.kind).toBe("advise");
    expect(readRalphState(tmp)!.iteration).toBe(2);
  });
});

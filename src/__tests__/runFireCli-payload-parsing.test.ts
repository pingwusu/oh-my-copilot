/**
 * Deterministic tests for `buildHookContextFromPayload` (runtime.ts).
 *
 * Background: the v1.4 RCA found that omcp's `runFireCli` previously read
 * only camelCase `sessionId` from Copilot's stdin payload, but Copilot's
 * vsCodeCompat path emits `session_id` (snake_case). The v1.4 fix accepts
 * both forms AND populates `ctx.payload` with the raw stdin object so
 * event-specific snake_case fields are visible to hook handlers.
 *
 * The mapping logic is now extracted into `buildHookContextFromPayload`
 * so it can be tested without spawning a subprocess or mocking stdin.
 * If this code regresses, every hook is silently broken — so this is
 * the highest-value test in the v1.4 release.
 *
 * The recipe is from the test-engineer release-readiness audit (v1.4.0).
 */

import { describe, it, expect } from "vitest";
import { buildHookContextFromPayload } from "../hooks/runtime.js";

describe("buildHookContextFromPayload (runFireCli ctx-building)", () => {
  describe("sessionId extraction — snake_case vs camelCase", () => {
    it("snake_case session_id (Copilot vsCodeCompat) → ctx.sessionId", () => {
      const raw = {
        hook_event_name: "Stop",
        session_id: "c87cb78f-e572-49cd-8851-029792f68513",
        timestamp: "2026-05-24T09:14:39.328Z",
        cwd: "C:\\Users\\runjiashi\\oh-my-copilot-r2",
        transcript_path: "C:\\Users\\...\\events.jsonl",
        stop_reason: "end_turn",
      };
      const ctx = buildHookContextFromPayload(raw, "/fallback");
      expect(ctx.sessionId).toBe("c87cb78f-e572-49cd-8851-029792f68513");
    });

    it("camelCase sessionId (canonical CC path) → ctx.sessionId", () => {
      const raw = {
        sessionId: "camel-session-456",
        cwd: "/some/path",
        stopReason: "end_turn",
      };
      const ctx = buildHookContextFromPayload(raw, "/fallback");
      expect(ctx.sessionId).toBe("camel-session-456");
    });

    it("camelCase takes precedence when both are present (canonical wins)", () => {
      const raw = {
        sessionId: "camel-wins",
        session_id: "snake-loses",
      };
      const ctx = buildHookContextFromPayload(raw, "/fallback");
      expect(ctx.sessionId).toBe("camel-wins");
    });

    it("empty payload → ctx.sessionId is empty string (not undefined)", () => {
      const ctx = buildHookContextFromPayload({}, "/fallback");
      expect(ctx.sessionId).toBe("");
    });

    it("non-string sessionId → empty string", () => {
      const ctx = buildHookContextFromPayload(
        { sessionId: 12345, session_id: null },
        "/fallback",
      );
      expect(ctx.sessionId).toBe("");
    });
  });

  describe("cwd extraction", () => {
    it("payload.cwd present → use it", () => {
      const ctx = buildHookContextFromPayload({ cwd: "/from/payload" }, "/fallback");
      expect(ctx.cwd).toBe("/from/payload");
    });

    it("payload.cwd missing → use fallbackCwd", () => {
      const ctx = buildHookContextFromPayload({}, "/fallback-cwd");
      expect(ctx.cwd).toBe("/fallback-cwd");
    });

    it("payload.cwd non-string → use fallbackCwd", () => {
      const ctx = buildHookContextFromPayload({ cwd: 42 }, "/fallback");
      expect(ctx.cwd).toBe("/fallback");
    });
  });

  describe("payload preservation", () => {
    it("ctx.payload carries raw snake_case fields intact (Stop event)", () => {
      const raw = {
        hook_event_name: "Stop",
        session_id: "abc-123",
        stop_reason: "context_limit_exceeded",
        transcript_path: "/tmp/events.jsonl",
        cwd: "/tmp/project",
        timestamp: "2026-05-24T00:00:00Z",
      };
      const ctx = buildHookContextFromPayload(raw, "/tmp/project");
      expect(ctx.payload).toBeDefined();
      expect(ctx.payload!.stop_reason).toBe("context_limit_exceeded");
      expect(ctx.payload!.transcript_path).toBe("/tmp/events.jsonl");
      expect(ctx.payload!.hook_event_name).toBe("Stop");
    });

    it("ctx.payload === rawPayload (reference passed through, no copy)", () => {
      const raw = { sessionId: "x", custom: "field" };
      const ctx = buildHookContextFromPayload(raw, "/fallback");
      expect(ctx.payload).toBe(raw);
    });

    it("empty payload → ctx.payload is empty object", () => {
      const ctx = buildHookContextFromPayload({}, "/fallback");
      expect(ctx.payload).toEqual({});
    });
  });

  describe("toolName / toolArgs / toolResult mapping (camelCase pass-through)", () => {
    it("PreToolUse: toolName + toolArgs propagate to ctx", () => {
      const raw = {
        hook_event_name: "PreToolUse",
        sessionId: "pre-789",
        toolName: "bash",
        toolArgs: { cmd: "ls -la" },
        cwd: "/project",
      };
      const ctx = buildHookContextFromPayload(raw, "/project");
      expect(ctx.toolName).toBe("bash");
      expect(ctx.toolArgs).toEqual({ cmd: "ls -la" });
    });

    it("PostToolUse: toolResult propagates", () => {
      const raw = {
        sessionId: "post-789",
        toolName: "bash",
        toolArgs: { cmd: "echo hi" },
        toolResult: { stdout: "hi\n", exitCode: 0 },
      };
      const ctx = buildHookContextFromPayload(raw, "/project");
      expect(ctx.toolResult).toEqual({ stdout: "hi\n", exitCode: 0 });
    });

    it("Stop event: toolName / toolArgs / toolResult are undefined (Copilot does not emit them)", () => {
      const raw = {
        hook_event_name: "Stop",
        session_id: "stop-1",
        stop_reason: "end_turn",
      };
      const ctx = buildHookContextFromPayload(raw, "/fallback");
      expect(ctx.toolName).toBeUndefined();
      expect(ctx.toolArgs).toBeUndefined();
      expect(ctx.toolResult).toBeUndefined();
    });

    it("non-string toolName → undefined", () => {
      const ctx = buildHookContextFromPayload({ toolName: 42 }, "/fallback");
      expect(ctx.toolName).toBeUndefined();
    });
  });

  describe("regression: the v1.4 RCA-fixed snake_case Stop scenario end-to-end", () => {
    it("exact Copilot 1.0.53-2 Stop payload (log line 1507) → correct ctx mapping", () => {
      // Verbatim shape from
      // C:\Users\runjiashi\.copilot\logs\process-1779613937047-31476.log:1507
      const raw = {
        hook_event_name: "Stop",
        session_id: "c87cb78f-e572-49cd-8851-029792f68513",
        timestamp: "2026-05-24T09:14:39.328Z",
        cwd: "C:\\Users\\runjiashi\\oh-my-copilot-r2",
        transcript_path:
          "C:\\Users\\runjiashi\\.copilot\\session-state\\c87cb78f-e572-49cd-8851-029792f68513\\events.jsonl",
        stop_reason: "end_turn",
      };
      const ctx = buildHookContextFromPayload(raw, "/should-not-be-used");

      // sessionId from snake_case session_id
      expect(ctx.sessionId).toBe("c87cb78f-e572-49cd-8851-029792f68513");
      // cwd from payload (not fallback)
      expect(ctx.cwd).toBe("C:\\Users\\runjiashi\\oh-my-copilot-r2");
      // tool* undefined (Stop doesn't emit them)
      expect(ctx.toolName).toBeUndefined();
      expect(ctx.toolArgs).toBeUndefined();
      expect(ctx.toolResult).toBeUndefined();
      // Raw payload preserved — hooks read snake_case fields via ctx.payload
      expect(ctx.payload!.stop_reason).toBe("end_turn");
      expect(ctx.payload!.transcript_path).toBe(raw.transcript_path);
      expect(ctx.payload!.hook_event_name).toBe("Stop");
    });
  });
});

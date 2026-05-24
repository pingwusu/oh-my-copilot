import { describe, it, expect } from "vitest";
import {
  mergeCopilotHooks,
  EVENT_DEFAULT_TIMEOUTS,
} from "../runtime/copilot-config.js";

const BIN = "/usr/local/bin/omcp";

function hookTimeout(result: ReturnType<typeof mergeCopilotHooks>, event: string): number {
  return result[event][result[event].length - 1].hooks[0].timeout as number;
}

describe("per-event hook timeouts", () => {
  it("applies 5s default to trivial events (PostToolUse, UserPromptSubmit, Notification)", () => {
    const next = mergeCopilotHooks(undefined, { omcpBin: BIN });
    expect(hookTimeout(next, "PostToolUse")).toBe(5);
    expect(hookTimeout(next, "UserPromptSubmit")).toBe(5);
    expect(hookTimeout(next, "Notification")).toBe(5);
  });

  it("applies 30s default to Stop event", () => {
    const next = mergeCopilotHooks(undefined, { omcpBin: BIN });
    expect(hookTimeout(next, "Stop")).toBe(30);
    expect(EVENT_DEFAULT_TIMEOUTS["Stop"]).toBe(30);
  });

  it("applies 30s default to PreCompact event", () => {
    const next = mergeCopilotHooks(undefined, { omcpBin: BIN });
    expect(hookTimeout(next, "PreCompact")).toBe(30);
    expect(EVENT_DEFAULT_TIMEOUTS["PreCompact"]).toBe(30);
  });

  it("global timeoutSec overrides built-in defaults for all events", () => {
    const next = mergeCopilotHooks(undefined, { omcpBin: BIN, timeoutSec: 15 });
    // trivial event
    expect(hookTimeout(next, "PostToolUse")).toBe(15);
    // events that would normally be 30s
    expect(hookTimeout(next, "Stop")).toBe(15);
    expect(hookTimeout(next, "PreCompact")).toBe(15);
  });

  it("timeoutsByEvent overrides default for Stop only; others keep their defaults", () => {
    const next = mergeCopilotHooks(undefined, {
      omcpBin: BIN,
      timeoutsByEvent: { Stop: 60 },
    });
    expect(hookTimeout(next, "Stop")).toBe(60);
    // PreCompact retains its 30s built-in default
    expect(hookTimeout(next, "PreCompact")).toBe(30);
    // trivial events retain 5s
    expect(hookTimeout(next, "PostToolUse")).toBe(5);
    expect(hookTimeout(next, "UserPromptSubmit")).toBe(5);
  });

  it("timeoutsByEvent overrides default for PostToolUse only; others keep their defaults", () => {
    const next = mergeCopilotHooks(undefined, {
      omcpBin: BIN,
      timeoutsByEvent: { PostToolUse: 10 },
    });
    expect(hookTimeout(next, "PostToolUse")).toBe(10);
    // Built-in 30s defaults unaffected
    expect(hookTimeout(next, "Stop")).toBe(30);
    expect(hookTimeout(next, "PreCompact")).toBe(30);
    // Other trivial events still 5s
    expect(hookTimeout(next, "UserPromptSubmit")).toBe(5);
  });

  it("timeoutsByEvent beats global timeoutSec for listed events; global wins for others", () => {
    const next = mergeCopilotHooks(undefined, {
      omcpBin: BIN,
      timeoutSec: 15,
      timeoutsByEvent: { Stop: 60 },
    });
    // per-event wins
    expect(hookTimeout(next, "Stop")).toBe(60);
    // global wins over built-in default
    expect(hookTimeout(next, "PreCompact")).toBe(15);
    expect(hookTimeout(next, "PostToolUse")).toBe(15);
  });
});

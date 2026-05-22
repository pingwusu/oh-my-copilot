// Tests for OMCP_HOOK_EVENTS expansion (v0.10.0: 5 -> 13 events).
// Guards against regression where OMCP_HOOK_EVENTS shrinks or gains invalid entries.

import { describe, it, expect } from "vitest";
import {
  OMCP_HOOK_EVENTS,
  COPILOT_VALID_EVENTS,
  mergeCopilotHooks,
} from "../runtime/copilot-config.js";

describe("OMCP_HOOK_EVENTS expansion", () => {
  it("has exactly 13 entries", () => {
    expect(OMCP_HOOK_EVENTS).toHaveLength(13);
  });

  it("contains all 13 expected event names", () => {
    const expected = [
      "SessionStart",
      "SessionEnd",
      "UserPromptSubmit",
      "PreToolUse",
      "PostToolUse",
      "PostToolUseFailure",
      "ErrorOccurred",
      "Stop",
      "SubagentStop",
      "subagentStart",
      "PreCompact",
      "PermissionRequest",
      "Notification",
    ] as const;
    const set = new Set<string>(OMCP_HOOK_EVENTS);
    for (const ev of expected) {
      expect(set.has(ev), `missing event: ${ev}`).toBe(true);
    }
  });

  it("every entry is in COPILOT_VALID_EVENTS", () => {
    const validSet = new Set<string>(COPILOT_VALID_EVENTS);
    for (const ev of OMCP_HOOK_EVENTS) {
      expect(validSet.has(ev), `invalid event: ${ev}`).toBe(true);
    }
  });

  it("includes subagentStart as camelCase only (no SubagentStart)", () => {
    const set = new Set<string>(OMCP_HOOK_EVENTS);
    expect(set.has("subagentStart")).toBe(true);
    expect(set.has("SubagentStart")).toBe(false);
  });

  it("mergeCopilotHooks(undefined, { events: OMCP_HOOK_EVENTS }) returns 13 entries", () => {
    const map = mergeCopilotHooks(undefined, { events: OMCP_HOOK_EVENTS });
    expect(Object.keys(map)).toHaveLength(13);
    for (const ev of OMCP_HOOK_EVENTS) {
      expect(map[ev], `missing map entry for ${ev}`).toBeDefined();
      expect(map[ev]).toHaveLength(1);
      expect(map[ev][0].hooks[0].__omcp).toBe(true);
    }
  });
});

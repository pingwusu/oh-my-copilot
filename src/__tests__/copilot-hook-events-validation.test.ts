// DD11 P0 regression test — ensures OMCP_HOOK_EVENTS only contains event
// names that Copilot CLI actually recognizes.
//
// Background: v0.4.0–v0.9.0 shipped OMCP_HOOK_EVENTS with Claude-Code-style
// names ("PreSubmit", "PostSubmit", "PreEnd"). Copilot CLI 1.0.48 silently
// drops unknown event names, so 3 of 6 omcp-managed hooks were dead in
// production. v0.9.1 fixes the constant; this test guards against
// regression.
//
// Authoritative source: the `aWr` Set extracted from the installed Copilot
// CLI bundle (`@github/copilot/app.js`, v1.0.48), cross-checked against
// docs.github.com/en/copilot/reference/hooks-configuration. 13 events
// total, both camelCase (internal) and PascalCase (alias) accepted EXCEPT
// `subagentStart` which has no PascalCase alias.

import { describe, expect, it } from "vitest";
import {
  COPILOT_VALID_EVENTS,
  OMCP_HOOK_EVENTS,
} from "../runtime/copilot-config.js";

describe("Copilot hook event name validation", () => {
  it("every OMCP_HOOK_EVENTS entry is in COPILOT_VALID_EVENTS", () => {
    const validSet = new Set<string>(COPILOT_VALID_EVENTS);
    for (const ev of OMCP_HOOK_EVENTS) {
      expect(
        validSet.has(ev),
        `OMCP_HOOK_EVENTS contains "${ev}" which is NOT a valid Copilot CLI hook event. ` +
          `If you intended a Claude-Code-style name, Copilot CLI will silently drop the ` +
          `hook entry. Valid names are: ${COPILOT_VALID_EVENTS.join(", ")}`,
      ).toBe(true);
    }
  });

  it("COPILOT_VALID_EVENTS contains exactly the 13 known event camelCase names", () => {
    const camelOnly = COPILOT_VALID_EVENTS.filter((e) => e[0] === e[0].toLowerCase());
    const expected = [
      "sessionStart",
      "sessionEnd",
      "userPromptSubmitted",
      "preToolUse",
      "postToolUse",
      "postToolUseFailure",
      "errorOccurred",
      "agentStop",
      "subagentStop",
      "subagentStart",
      "preCompact",
      "permissionRequest",
      "notification",
    ];
    expect(camelOnly.sort()).toEqual(expected.sort());
  });

  it("COPILOT_VALID_EVENTS PascalCase aliases match the documented `s2t` map", () => {
    const pascalOnly = COPILOT_VALID_EVENTS.filter((e) => e[0] === e[0].toUpperCase());
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
      "PreCompact",
      "PermissionRequest",
      "Notification",
    ];
    expect(pascalOnly.sort()).toEqual(expected.sort());
  });

  it("the Claude-Code-style misnomers from v0.4–v0.9 are NOT in COPILOT_VALID_EVENTS", () => {
    const validSet = new Set<string>(COPILOT_VALID_EVENTS);
    expect(validSet.has("PreSubmit")).toBe(false);
    expect(validSet.has("PostSubmit")).toBe(false);
    expect(validSet.has("PreEnd")).toBe(false);
  });

  it("`subagentStart` is intentionally camelCase-only (no PascalCase alias)", () => {
    const validSet = new Set<string>(COPILOT_VALID_EVENTS);
    expect(validSet.has("subagentStart")).toBe(true);
    expect(validSet.has("SubagentStart")).toBe(false);
  });
});

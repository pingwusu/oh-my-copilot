import { describe, it, expect } from "vitest";
import { createRegistry } from "../hooks/hook-types.js";
import { suggestFleetHook } from "../hooks/suggest-fleet.js";

const baseCtx = {
  sessionId: "s1",
  cwd: process.cwd(),
};

describe("hook registry", () => {
  it("dispatches only to hooks subscribed to the event", async () => {
    const r = createRegistry();
    r.register(suggestFleetHook);
    const out = await r.dispatch({
      ...baseCtx,
      event: "PostToolUse",
      toolArgs: "many files",
    });
    // suggestFleet listens for PreToolUse only
    expect(out).toEqual([]);
  });

  it("returns advise when trigger matches", async () => {
    const r = createRegistry();
    r.register(suggestFleetHook);
    const out = await r.dispatch({
      ...baseCtx,
      event: "PreToolUse",
      toolArgs: "Run this on several files",
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: "advise" });
  });

  it("returns noop when no trigger", async () => {
    const r = createRegistry();
    r.register(suggestFleetHook);
    const out = await r.dispatch({
      ...baseCtx,
      event: "PreToolUse",
      toolArgs: "Read this single file",
    });
    expect(out).toEqual([{ kind: "noop" }]);
  });
});

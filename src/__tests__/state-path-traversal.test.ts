// DD8 Critic-A P0 regression test: COPILOT_SESSION_ID must be slug-validated
// before reaching path.join. Without the safe-slug guard, an attacker who
// controls the env var (or a malicious Copilot extension) can write/read/clear
// arbitrary JSON files outside .omcp/state/.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("state CLI rejects path-traversal via COPILOT_SESSION_ID", () => {
  let tmp: string;
  let prevCwd: string;
  let prevSession: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "omcp-dd8-statetrav-"));
    prevCwd = process.cwd();
    process.chdir(tmp);
    prevSession = process.env.COPILOT_SESSION_ID;
  });

  afterEach(() => {
    process.chdir(prevCwd);
    if (prevSession === undefined) delete process.env.COPILOT_SESSION_ID;
    else process.env.COPILOT_SESSION_ID = prevSession;
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      // ignore cleanup error
    }
  });

  it("writeState throws when COPILOT_SESSION_ID contains ..", async () => {
    process.env.COPILOT_SESSION_ID = "../../../bad";
    const { writeState } = await import("../cli/commands/state.js");
    expect(() => writeState("ralph", { active: true })).toThrow(/sessionId/);
  });

  it("readState throws when COPILOT_SESSION_ID contains a slash", async () => {
    process.env.COPILOT_SESSION_ID = "evil/sub";
    const { readState } = await import("../cli/commands/state.js");
    expect(() => readState("ralph")).toThrow(/sessionId/);
  });

  it("clearState throws when COPILOT_SESSION_ID contains a backslash", async () => {
    process.env.COPILOT_SESSION_ID = "evil\\sub";
    const { clearState } = await import("../cli/commands/state.js");
    expect(() => clearState("ralph")).toThrow(/sessionId/);
  });

  it("plain slug sessionId still works (regression guard for the guard)", async () => {
    process.env.COPILOT_SESSION_ID = "session-abc123";
    const { writeState, readState } = await import("../cli/commands/state.js");
    writeState("ralph", { active: true });
    expect(readState("ralph")).toEqual({ active: true });
  });
});

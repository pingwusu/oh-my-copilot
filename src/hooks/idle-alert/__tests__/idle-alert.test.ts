import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  createIdleAlertHook,
  stateFilePath,
  loadState,
  persistState,
  formatDuration,
  DEFAULT_THRESHOLD_MS,
} from "../index.js";
import type { HookContext } from "../../hook-types.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "omcp-idle-test-"));
}

function makeCtx(
  cwd: string,
  sessionId = "test-session-1",
): HookContext {
  return {
    event: "Notification",
    sessionId,
    cwd,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("idle-alert", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = makeTempDir();
    vi.useFakeTimers();
    delete process.env.OMCP_IDLE_ALERT_THRESHOLD_MS;
  });

  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
    vi.useRealTimers();
    delete process.env.OMCP_IDLE_ALERT_THRESHOLD_MS;
  });

  // ── 1. First fire (no state yet) → noop, state created ───────────────────

  it("returns noop on first fire and creates state file", async () => {
    vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));

    const hook = createIdleAlertHook();
    const result = await hook.run(makeCtx(cwd));
    expect(result).toEqual({ kind: "noop" });

    // State file must exist
    const statePath = stateFilePath(cwd, "test-session-1");
    expect(fs.existsSync(statePath)).toBe(true);
    const state = loadState(cwd, "test-session-1");
    expect(state).not.toBeNull();
    expect(typeof state!.lastFireTs).toBe("number");
  });

  // ── 2. Fire within threshold → noop, state updated ───────────────────────

  it("returns noop when gap is below the idle threshold", async () => {
    vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));

    const hook = createIdleAlertHook();

    // First fire
    await hook.run(makeCtx(cwd));

    // Advance time by 1 minute (below default 5-minute threshold)
    vi.advanceTimersByTime(60_000);

    // Second fire within threshold
    const result = await hook.run(makeCtx(cwd));
    expect(result).toEqual({ kind: "noop" });
  });

  // ── 3. Fire after threshold → advise with gap duration ───────────────────

  it("returns advise when gap exceeds the idle threshold", async () => {
    vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));

    const hook = createIdleAlertHook();

    // First fire
    await hook.run(makeCtx(cwd));

    // Advance time by 10 minutes (exceeds default 5-minute threshold)
    vi.advanceTimersByTime(10 * 60_000);

    // Second fire after threshold
    const result = await hook.run(makeCtx(cwd));
    expect(result.kind).toBe("advise");
    if (result.kind === "advise") {
      expect(result.text).toContain("10m");
      expect(result.text).toContain("idle");
    }
  });

  // ── 4. Custom threshold via env ───────────────────────────────────────────

  it("respects OMCP_IDLE_ALERT_THRESHOLD_MS env var", async () => {
    process.env.OMCP_IDLE_ALERT_THRESHOLD_MS = "30000"; // 30 seconds

    vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));

    const hook = createIdleAlertHook();

    // First fire
    await hook.run(makeCtx(cwd, "env-session"));

    // Advance time by 45 seconds (exceeds custom 30-second threshold)
    vi.advanceTimersByTime(45_000);

    const result = await hook.run(makeCtx(cwd, "env-session"));
    expect(result.kind).toBe("advise");
    if (result.kind === "advise") {
      expect(result.text).toContain("45s");
    }
  });

  // ── 5. Per-session state isolation ───────────────────────────────────────

  it("tracks state independently per session", async () => {
    vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));

    const hook = createIdleAlertHook();

    // Session A fires
    await hook.run(makeCtx(cwd, "session-a"));

    // Advance 10 minutes
    vi.advanceTimersByTime(10 * 60_000);

    // Session B fires for the first time (no prior state) → noop
    const resultB = await hook.run(makeCtx(cwd, "session-b"));
    expect(resultB).toEqual({ kind: "noop" });

    // Session A fires again after 10 minutes → advise
    const resultA = await hook.run(makeCtx(cwd, "session-a"));
    expect(resultA.kind).toBe("advise");
  });

  // ── 6. formatDuration unit tests ─────────────────────────────────────────

  it("formatDuration formats seconds correctly", () => {
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(0)).toBe("0s");
  });

  it("formatDuration formats minutes and seconds correctly", () => {
    expect(formatDuration(10 * 60_000)).toBe("10m 0s");
    expect(formatDuration(10 * 60_000 + 30_000)).toBe("10m 30s");
  });

  // ── 7. Subscribes to Notification event ──────────────────────────────────

  it("subscribes to Notification event", () => {
    const hook = createIdleAlertHook();
    expect(hook.events).toContain("Notification");
    expect(hook.name).toBe("idle-alert");
  });

  // ── 8. DEFAULT_THRESHOLD_MS is 5 minutes ─────────────────────────────────

  it("DEFAULT_THRESHOLD_MS is 5 minutes (300000ms)", () => {
    expect(DEFAULT_THRESHOLD_MS).toBe(300_000);
  });
});

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

// ─── Mock background-notifications before importing hook ─────────────────────

vi.mock("../../background-notifications.js", () => ({
  dispatchNotificationInBackground: vi.fn(),
}));

import {
  createNotificationDispatcherHook,
  notificationsFilePath,
  appendNotificationRecord,
} from "../index.js";
import { dispatchNotificationInBackground } from "../../background-notifications.js";
import type { HookContext } from "../../hook-types.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "omcp-notif-test-"));
}

function makeCtx(
  overrides: Partial<HookContext> & { cwd: string },
): HookContext {
  return {
    event: "Notification",
    sessionId: "test-session-1",
    ...overrides,
  };
}

function readLogLines(cwd: string): string[] {
  const file = notificationsFilePath(cwd);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf-8")
    .split("\n")
    .filter((l) => l.trim().length > 0);
}

const mockDispatch = dispatchNotificationInBackground as ReturnType<typeof vi.fn>;

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("notification-dispatcher", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = makeTempDir();
    vi.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  // ── 1. Notification with payload → dispatched + logged ───────────────────

  it("dispatches notification and logs to notifications.jsonl", async () => {
    const hook = createNotificationDispatcherHook();
    const ctx = makeCtx({
      cwd,
      sessionId: "sess-abc",
      toolArgs: { title: "Task complete", body: "All done" },
    });

    const result = await hook.run(ctx);
    expect(result).toEqual({ kind: "noop" });

    // Dispatch was called
    expect(mockDispatch).toHaveBeenCalledOnce();

    // Audit log written
    const lines = readLogLines(cwd);
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]);
    expect(record.sessionId).toBe("sess-abc");
    expect(record.payload).toMatchObject({ title: "Task complete" });
    expect(typeof record.ts).toBe("string");
  });

  // ── 2. Missing payload → fallback handling (no crash) ────────────────────

  it("handles missing payload (undefined toolArgs) gracefully", async () => {
    const hook = createNotificationDispatcherHook();
    const ctx = makeCtx({ cwd });
    // toolArgs is undefined by default

    const result = await hook.run(ctx);
    expect(result).toEqual({ kind: "noop" });

    const lines = readLogLines(cwd);
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]);
    expect(record.payload).toBeNull();
  });

  // ── 3. Dispatch failure → still logs (graceful degrade) ──────────────────

  it("still logs audit record even when dispatch throws", async () => {
    mockDispatch.mockImplementationOnce(() => {
      throw new Error("dispatch failed");
    });

    const hook = createNotificationDispatcherHook();
    const ctx = makeCtx({
      cwd,
      toolArgs: { body: "some notification" },
    });

    // Must not throw
    const result = await hook.run(ctx);
    expect(result).toEqual({ kind: "noop" });

    // Audit log still written
    const lines = readLogLines(cwd);
    expect(lines).toHaveLength(1);
  });

  // ── 4. Multiple notifications in sequence → all logged in order ──────────

  it("logs multiple notifications in order", async () => {
    const hook = createNotificationDispatcherHook();

    for (let i = 1; i <= 3; i++) {
      await hook.run(
        makeCtx({
          cwd,
          sessionId: `sess-${i}`,
          toolArgs: { index: i },
        }),
      );
    }

    const lines = readLogLines(cwd);
    expect(lines).toHaveLength(3);

    const records = lines.map((l) => JSON.parse(l));
    expect(records[0].sessionId).toBe("sess-1");
    expect(records[1].sessionId).toBe("sess-2");
    expect(records[2].sessionId).toBe("sess-3");
  });

  // ── 5. Returns noop always ────────────────────────────────────────────────

  it("always returns noop (observational hook)", async () => {
    const hook = createNotificationDispatcherHook();
    const result = await hook.run(makeCtx({ cwd }));
    expect(result).toEqual({ kind: "noop" });
  });

  // ── 6. Subscribes to Notification event ──────────────────────────────────

  it("subscribes to Notification event", () => {
    const hook = createNotificationDispatcherHook();
    expect(hook.events).toContain("Notification");
    expect(hook.name).toBe("notification-dispatcher");
  });

  // ── 7. appendNotificationRecord unit test ────────────────────────────────

  it("appendNotificationRecord creates parent dirs if needed", () => {
    appendNotificationRecord(cwd, {
      ts: new Date().toISOString(),
      sessionId: "unit-test",
      payload: { x: 1 },
    });

    const lines = readLogLines(cwd);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).sessionId).toBe("unit-test");
  });
});

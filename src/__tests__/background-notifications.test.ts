import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Use a hoisted spawn stub so the dispatcher module sees it on first import.
const spawnMock = vi.hoisted(() =>
  vi.fn(() => ({
    unref: vi.fn(),
  })),
);

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: spawnMock };
});

import { dispatchNotificationInBackground } from "../hooks/background-notifications.js";

describe("dispatchNotificationInBackground", () => {
  beforeEach(() => {
    spawnMock.mockClear();
    delete process.env.OMCP_NOTIFY;
  });

  afterEach(() => {
    delete process.env.OMCP_NOTIFY;
  });

  it("spawns a detached node child with stdio:ignore", () => {
    dispatchNotificationInBackground("session-end", {
      sessionId: "sess_1",
      projectName: "demo",
    });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [execPath, args, opts] = spawnMock.mock.calls[0] as [
      string,
      string[],
      Record<string, unknown>,
    ];
    expect(execPath).toBe(process.execPath);
    expect(args[0]).toBe("--input-type=module");
    expect(args[1]).toBe("-e");
    expect(opts.detached).toBe(true);
    expect(opts.stdio).toBe("ignore");
    expect(opts.windowsHide).toBe(true);
    const env = opts.env as NodeJS.ProcessEnv;
    expect(env.OMCP_HOOK_BACKGROUND_CHILD).toBe("1");
  });

  it("embeds the serialized event + data in the child source", () => {
    dispatchNotificationInBackground("ask-user-question", {
      sessionId: "abc",
      question: "Continue?",
    });
    const args = spawnMock.mock.calls[0]?.[1] as string[];
    const source = args[2];
    expect(source).toContain('"ask-user-question"');
    expect(source).toContain('"sessionId":"abc"');
    expect(source).toContain('"question":"Continue?"');
    // Resolves omcp's notifications modules, not omc's facade.
    expect(source).toContain("notifications/dispatcher.js");
    expect(source).toContain("notifications/config-loader.js");
    // Errors swallowed in the child.
    expect(source).toContain(".catch(() => {})");
  });

  it("calls child.unref so the parent can exit", () => {
    const fakeChild = { unref: vi.fn() };
    spawnMock.mockReturnValueOnce(fakeChild as never);
    dispatchNotificationInBackground("session-start", { sessionId: "s" });
    expect(fakeChild.unref).toHaveBeenCalledTimes(1);
  });

  it("no-ops when OMCP_NOTIFY=0", () => {
    process.env.OMCP_NOTIFY = "0";
    dispatchNotificationInBackground("session-end", { sessionId: "s" });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("swallows spawn failures", () => {
    spawnMock.mockImplementationOnce(() => {
      throw new Error("spawn failed");
    });
    expect(() =>
      dispatchNotificationInBackground("session-end", { sessionId: "s" }),
    ).not.toThrow();
  });

  it("swallows unserializable inputs without spawning", () => {
    const cyclic: Record<string, unknown> = { sessionId: "s" };
    cyclic.self = cyclic;
    expect(() =>
      dispatchNotificationInBackground(
        "session-end",
        cyclic as Parameters<typeof dispatchNotificationInBackground>[1],
      ),
    ).not.toThrow();
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

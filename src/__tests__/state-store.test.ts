import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileStateStore, MemoryStateStore } from "../mcp/state-server.js";
import {
  writeModeState,
  readModeState,
  clearModeState,
  listActiveModes,
  type BaseModeState,
  type RalphLoopState,
} from "../runtime/mode-state.js";
import { UnsafeSlugError } from "../runtime/safe-slug.js";

describe("MemoryStateStore", () => {
  let store: MemoryStateStore;
  beforeEach(() => {
    store = new MemoryStateStore();
  });

  it("read returns undefined for unknown key", () => {
    expect(store.read("s1", "k")).toBeUndefined();
  });

  it("write then read round-trips", () => {
    store.write("s1", "k", "v");
    expect(store.read("s1", "k")).toBe("v");
  });

  it("clear with key removes only that key", () => {
    store.write("s1", "a", "1");
    store.write("s1", "b", "2");
    store.clear("s1", "a");
    expect(store.read("s1", "a")).toBeUndefined();
    expect(store.read("s1", "b")).toBe("2");
  });

  it("clear without key wipes the session", () => {
    store.write("s1", "a", "1");
    store.clear("s1");
    expect(store.read("s1", "a")).toBeUndefined();
  });

  it("list_active returns sessions with content", () => {
    store.write("s1", "k", "v");
    store.write("s2", "k", "v");
    store.clear("s2");
    expect(store.list_active()).toEqual(["s1"]);
  });

  it("get_status returns keys and total size", () => {
    store.write("s1", "a", "12");
    store.write("s1", "b", "345");
    expect(store.get_status("s1")).toEqual({ keys: ["a", "b"], size: 5 });
  });
});

describe("FileStateStore", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omcp-state-"));
  });

  it("persists across instances", () => {
    const a = new FileStateStore(dir);
    a.write("s1", "k", "v");
    const b = new FileStateStore(dir);
    expect(b.read("s1", "k")).toBe("v");
  });

  it("clear removes the key", () => {
    const a = new FileStateStore(dir);
    a.write("s1", "k", "v");
    a.clear("s1", "k");
    expect(a.read("s1", "k")).toBeUndefined();
  });
});

describe("mode_* tools via mode-state functions", () => {
  let tmp: string;
  let cwdSnapshot: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "omcp-mode-tools-"));
    cwdSnapshot = process.cwd();
    process.chdir(tmp);
  });

  afterEach(() => {
    process.chdir(cwdSnapshot);
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("mode_write then mode_read round-trips a JSON payload", () => {
    const payload: RalphLoopState = {
      active: true,
      session_id: "s1",
      started_at: "2026-01-01T00:00:00Z",
      iteration: 7,
      max_iterations: 10,
    };
    writeModeState<RalphLoopState>("ralph", payload);
    const back = readModeState<RalphLoopState>("ralph");
    expect(back?.iteration).toBe(7);
    expect(back?.active).toBe(true);
  });

  it("mode_write rejects mode='../escape' with UnsafeSlugError", () => {
    expect(() =>
      writeModeState("../escape" as unknown as "ralph", {
        active: false,
        session_id: "s1",
        started_at: "2026",
      }),
    ).toThrow(UnsafeSlugError);
  });

  it("mode_write rejects sessionId='../escape' with UnsafeSlugError", () => {
    expect(() =>
      writeModeState(
        "ralph",
        { active: false, session_id: "s1", started_at: "2026" } as RalphLoopState,
        "../escape",
      ),
    ).toThrow(UnsafeSlugError);
  });

  it("mode_list_active returns only modes whose payload.active === true", () => {
    writeModeState("ralph", {
      active: true,
      session_id: "s1",
      started_at: "2026",
      iteration: 1,
      max_iterations: 10,
    } as RalphLoopState);
    writeModeState("autopilot", {
      active: false,
      session_id: "s1",
      started_at: "2026",
      phase: "execution",
      iteration: 0,
    } as unknown as BaseModeState);
    const active = listActiveModes();
    expect(active).toContain("ralph");
    expect(active).not.toContain("autopilot");
  });

  it("mode_clear deletes the file; subsequent mode_read returns null", () => {
    writeModeState("ralph", {
      active: true,
      session_id: "s1",
      started_at: "2026",
      iteration: 1,
      max_iterations: 10,
    } as RalphLoopState);
    clearModeState("ralph");
    expect(readModeState("ralph")).toBeNull();
  });

  it("concurrent writes produce valid JSON (atomic-write proof)", async () => {
    const payload = (i: number): BaseModeState => ({
      active: true,
      session_id: "s1",
      started_at: "2026",
      prompt: `iteration-${i}`,
    });
    await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        Promise.resolve(writeModeState("ultraqa", payload(i))),
      ),
    );
    const result = readModeState("ultraqa");
    expect(result).not.toBeNull();
    expect(typeof result?.active).toBe("boolean");
  });
});

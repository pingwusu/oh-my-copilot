import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileStateStore, MemoryStateStore } from "../mcp/state-server.js";

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

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeSharedMemory,
  readSharedMemory,
  listSharedMemory,
  deleteSharedMemory,
  cleanupSharedMemory,
} from "../runtime/shared-memory.js";
import { UnsafeSlugError } from "../runtime/safe-slug.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "omcp-shmem-"));
});

afterEach(() => {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe("shared_memory_write + shared_memory_read", () => {
  it("(a) happy path: write then read returns the same value", () => {
    writeSharedMemory("mykey", { foo: 42 }, undefined, tmp);
    const result = readSharedMemory("mykey", tmp);
    expect(result).not.toBeNull();
    expect(result?.value).toEqual({ foo: 42 });
    expect(result?.expiresAt).toBeNull();
  });

  it("(a) write with ttl stores a future expiresAt", () => {
    const before = Date.now();
    writeSharedMemory("ttlkey", "hello", 5000, tmp);
    const result = readSharedMemory("ttlkey", tmp);
    expect(result).not.toBeNull();
    expect(result?.expiresAt).toBeGreaterThan(before);
  });
});

describe("shared_memory_read", () => {
  it("(b) read missing key returns null", () => {
    const result = readSharedMemory("nonexistent", tmp);
    expect(result).toBeNull();
  });

  it("(c) read expired key returns null", () => {
    // Write with a past expiresAt by using ttl_ms=1, then fake expiry via direct file write
    mkdirSync(tmp, { recursive: true });
    const expired = { value: "stale", expiresAt: Date.now() - 1000 };
    writeFileSync(join(tmp, "expired.json"), JSON.stringify(expired));
    const result = readSharedMemory("expired", tmp);
    expect(result).toBeNull();
  });
});

describe("shared_memory_list", () => {
  it("(d) list returns active keys, excludes expired", () => {
    writeSharedMemory("active1", "val1", undefined, tmp);
    writeSharedMemory("active2", "val2", undefined, tmp);
    // Plant an expired entry directly
    const expired = { value: "gone", expiresAt: Date.now() - 1000 };
    writeFileSync(join(tmp, "old.json"), JSON.stringify(expired));

    const { keys } = listSharedMemory(tmp);
    expect(keys).toContain("active1");
    expect(keys).toContain("active2");
    expect(keys).not.toContain("old");
  });

  it("(d) list returns empty when directory does not exist", () => {
    const { keys } = listSharedMemory(join(tmp, "missing"));
    expect(keys).toEqual([]);
  });
});

describe("shared_memory_delete", () => {
  it("(e) delete removes the key; subsequent read returns null", () => {
    writeSharedMemory("delkey", "bye", undefined, tmp);
    const { deleted } = deleteSharedMemory("delkey", tmp);
    expect(deleted).toBe(true);
    expect(readSharedMemory("delkey", tmp)).toBeNull();
  });

  it("(e) delete on missing key returns deleted=false", () => {
    const { deleted } = deleteSharedMemory("ghost", tmp);
    expect(deleted).toBe(false);
  });
});

describe("shared_memory_cleanup", () => {
  it("(f) cleanup removes expired entries, leaves active ones", () => {
    writeSharedMemory("keep", "alive", undefined, tmp);
    const exp1 = { value: "x", expiresAt: Date.now() - 1 };
    const exp2 = { value: "y", expiresAt: Date.now() - 1 };
    writeFileSync(join(tmp, "exp1.json"), JSON.stringify(exp1));
    writeFileSync(join(tmp, "exp2.json"), JSON.stringify(exp2));

    const { removed } = cleanupSharedMemory(tmp);
    expect(removed).toBe(2);

    // active key still readable
    expect(readSharedMemory("keep", tmp)).not.toBeNull();
    // expired keys gone
    expect(readSharedMemory("exp1", tmp)).toBeNull();
    expect(readSharedMemory("exp2", tmp)).toBeNull();
  });

  it("(f) cleanup on missing directory returns removed=0", () => {
    const { removed } = cleanupSharedMemory(join(tmp, "absent"));
    expect(removed).toBe(0);
  });
});

describe("assertSafeSlug enforcement", () => {
  it("(g) write blocks path traversal key", () => {
    expect(() => writeSharedMemory("../escape", "x", undefined, tmp)).toThrow(
      UnsafeSlugError,
    );
  });

  it("(g) read blocks path traversal key", () => {
    expect(() => readSharedMemory("../../etc/passwd", tmp)).toThrow(
      UnsafeSlugError,
    );
  });

  it("(g) delete blocks path traversal key", () => {
    expect(() => deleteSharedMemory("evil\\key", tmp)).toThrow(UnsafeSlugError);
  });
});

describe("corruption resilience", () => {
  it("(h) corrupted JSON file is skipped by list (no crash)", () => {
    writeSharedMemory("good", "ok", undefined, tmp);
    writeFileSync(join(tmp, "corrupt.json"), "{{not valid json}}");

    const { keys } = listSharedMemory(tmp);
    expect(keys).toContain("good");
    expect(keys).not.toContain("corrupt");
  });

  it("(h) read of corrupted JSON returns null", () => {
    writeFileSync(join(tmp, "bad.json"), "not-json");
    const result = readSharedMemory("bad", tmp);
    expect(result).toBeNull();
  });
});

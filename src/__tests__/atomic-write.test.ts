import { mkdtempSync, readdirSync, readFileSync, rmSync, chmodSync } from "node:fs";
import { platform } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { atomicWriteFileSync } from "../runtime/atomic-write.js";

describe("atomicWriteFileSync", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omcp-atomic-"));
  });

  afterEach(() => {
    // Restore permissions in case the test changed them (non-Windows only)
    try {
      if (platform() !== "win32") chmodSync(dir, 0o755);
    } catch { /* ignore */ }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("writes the correct bytes to the target path", () => {
    const target = join(dir, "out.json");
    atomicWriteFileSync(target, '{"ok":true}');
    expect(readFileSync(target, "utf8")).toBe('{"ok":true}');
  });

  it("leaves no temp residue on success", () => {
    const target = join(dir, "out.json");
    atomicWriteFileSync(target, "hello");
    const files = readdirSync(dir);
    expect(files).toEqual(["out.json"]);
  });

  it("leaves no temp residue when write fails (read-only dir, non-Windows)", () => {
    // On Windows chmod has no effect — skip this test.
    if (platform() === "win32") return;
    chmodSync(dir, 0o555); // read-only: openSync("w") will fail
    const target = join(dir, "out.json");
    expect(() => atomicWriteFileSync(target, "data")).toThrow();
    chmodSync(dir, 0o755); // restore so afterEach cleanup works
    // No .tmp files remain (open failed before write, so nothing created)
    const files = readdirSync(dir);
    expect(files.some((f) => f.includes(".tmp."))).toBe(false);
  });

  it("overwrites an existing target atomically", () => {
    const target = join(dir, "out.json");
    atomicWriteFileSync(target, "first");
    atomicWriteFileSync(target, "second");
    expect(readFileSync(target, "utf8")).toBe("second");
  });

  // RC4-P1-A fix: the previous "no temp residue on rename failure" test only ran
  // on POSIX (chmod read-only dir). On Windows it returned early — masking the
  // cleanup branch. This cross-platform variant uses a nonexistent parent dir
  // so openSync of the tmp file fails on every platform.
  it("leaves no temp residue when open fails (cross-platform)", () => {
    const bogus = join(dir, "does-not-exist", "out.json");
    expect(() => atomicWriteFileSync(bogus, "data")).toThrow();
    // The non-existent dir was never created
    const files = readdirSync(dir);
    expect(files).toEqual([]);
  });
});

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isDirectInvocation } from "../cli/omcp.js";

// Regression test for the Phase A bootstrap bug: when omcp is invoked via the
// shim that npm link / npm install -g writes to the global bin, process.argv[1]
// is the symlink path (e.g. C:\.tools\.npm-global\node_modules\oh-my-copilot\
// dist\cli\omcp.js) but Node's ESM resolver realpaths import.meta.url to the
// real package root (C:\Users\...\oh-my-copilot-r2\dist\cli\omcp.js). The old
// implementation compared the two with `resolve()` only, so they diverged and
// the entry guard silently no-op'd — `omcp --version` exited 0 with no output.
describe("isDirectInvocation — symlink-tolerant entry guard", () => {
  let tmp: string;
  let real: string;
  let link: string;
  let other: string;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "omcp-entry-"));
    real = join(tmp, "real.js");
    link = join(tmp, "link.js");
    other = join(tmp, "other.js");
    writeFileSync(real, "// fake entry");
    writeFileSync(other, "// unrelated entry");
    symlinkSync(real, link, "file");
  });

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns false when entry is undefined", () => {
    expect(isDirectInvocation(undefined, real)).toBe(false);
  });

  it("returns true when entry equals here (no symlink)", () => {
    expect(isDirectInvocation(real, real)).toBe(true);
  });

  it("returns true when entry is a symlink whose target equals here (npm-link case)", () => {
    expect(isDirectInvocation(link, real)).toBe(true);
  });

  it("returns true when here is a symlink whose target equals entry (reverse npm-link case)", () => {
    expect(isDirectInvocation(real, link)).toBe(true);
  });

  it("returns false when entry and here resolve to different real files", () => {
    expect(isDirectInvocation(other, real)).toBe(false);
  });

  it("falls back to resolve() when entry path does not exist on disk", () => {
    const missing = join(tmp, "does-not-exist.js");
    // realpathSync throws ENOENT; canonicalize() catches and falls back to
    // resolve() which compares the literal paths.
    expect(isDirectInvocation(missing, real)).toBe(false);
    expect(isDirectInvocation(missing, missing)).toBe(true);
  });

  it("returns false when entry is an empty string", () => {
    // Empty string is truthy as a defined value but the guard treats undefined
    // as the only "not provided" signal — empty string should canonicalize to
    // cwd and almost certainly differ from `here`.
    const result = isDirectInvocation("", real);
    expect(result).toBe(false);
  });

  it("handles a directory that contains a nested symlinked dist (npm-link directory-level case)", () => {
    const realDir = join(tmp, "pkg-real");
    mkdirSync(realDir, { recursive: true });
    const realEntry = join(realDir, "entry.js");
    writeFileSync(realEntry, "// dir-symlink entry");
    const linkDir = join(tmp, "pkg-link");
    symlinkSync(realDir, linkDir, "dir");
    const linkEntry = join(linkDir, "entry.js");
    expect(isDirectInvocation(linkEntry, realEntry)).toBe(true);
  });
});

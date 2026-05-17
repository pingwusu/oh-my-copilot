import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearReasoning,
  readReasoning,
  writeReasoning,
} from "../cli/commands/reasoning.js";

describe("reasoning", () => {
  let tmp: string;
  let prevHome: string | undefined;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "omcp-reasoning-"));
    prevHome = process.env.OMCP_HOME;
    process.env.OMCP_HOME = tmp;
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.OMCP_HOME;
    else process.env.OMCP_HOME = prevHome;
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("readReasoning returns undefined when nothing set", () => {
    expect(readReasoning()).toBeUndefined();
  });

  it("writeReasoning persists + readReasoning round-trips", () => {
    const r = writeReasoning("high");
    expect(r.path).toContain(".omcp-config.json");
    expect(readReasoning()).toBe("high");
    const blob = JSON.parse(readFileSync(r.path, "utf8"));
    expect(blob.reasoning.effort).toBe("high");
  });

  it("rejects invalid levels", () => {
    expect(() => writeReasoning("ultra" as never)).toThrow();
  });

  it("preserves unrelated keys when writing", () => {
    const f = join(tmp, ".omcp-config.json");
    writeFileSync(f, JSON.stringify({ notifications: { telegram: { ok: true } } }));
    writeReasoning("medium");
    const blob = JSON.parse(readFileSync(f, "utf8"));
    expect(blob.reasoning.effort).toBe("medium");
    expect(blob.notifications.telegram.ok).toBe(true);
  });

  it("clearReasoning removes the key", () => {
    writeReasoning("low");
    clearReasoning();
    expect(readReasoning()).toBeUndefined();
  });

  it("clearReasoning on absent file returns cleared=false", () => {
    expect(clearReasoning().cleared).toBe(false);
    expect(existsSync(join(tmp, ".omcp-config.json"))).toBe(false);
  });
});

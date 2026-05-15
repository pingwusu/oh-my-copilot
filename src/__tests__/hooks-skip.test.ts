import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadHooks } from "../hooks/runtime.js";

describe("hooks DISABLE_OMCP / OMCP_SKIP_HOOKS", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "omcp-hooks-skip-"));
    writeFileSync(
      join(tmp, "hook-a.ts"),
      `export default { name: "hook-a", events: ["PreToolUse"], async run() { return { kind: "noop" }; } };`,
    );
    writeFileSync(
      join(tmp, "hook-b.ts"),
      `export default { name: "hook-b", events: ["PreToolUse"], async run() { return { kind: "noop" }; } };`,
    );
  });
  afterEach(() => {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("DISABLE_OMCP=1 yields empty registry", async () => {
    const r = await loadHooks({
      pluginHooksDir: tmp,
      repoHooksDir: tmp + "-none",
      env: { DISABLE_OMCP: "1" },
    });
    expect(r.hooks).toHaveLength(0);
  });

  it("OMCP_SKIP_HOOKS skips listed hook by basename", async () => {
    const r = await loadHooks({
      pluginHooksDir: tmp,
      repoHooksDir: tmp + "-none",
      env: { OMCP_SKIP_HOOKS: "hook-a" },
    });
    const names = r.hooks.map((h) => h.name);
    expect(names).toContain("hook-b");
    expect(names).not.toContain("hook-a");
  });

  it("no kill switch loads both hooks", async () => {
    const r = await loadHooks({
      pluginHooksDir: tmp,
      repoHooksDir: tmp + "-none",
      env: {},
    });
    expect(r.hooks.length).toBeGreaterThanOrEqual(2);
  });
});

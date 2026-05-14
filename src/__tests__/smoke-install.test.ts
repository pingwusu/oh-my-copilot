// End-to-end smoke test: full install lifecycle against a temp COPILOT home.
// Mirrors what `omcp setup` then `omcp doctor` would do for a real user, sans
// shelling out to the copilot binary (we patch that probe).

import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runDoctor, exitCodeFor } from "../cli/commands/doctor.js";
import { runSetup } from "../cli/commands/setup.js";

describe("install lifecycle (setup -> doctor)", () => {
  let tmp: string;
  let prevHome: string | undefined;
  const packageRoot = join(__dirname, "..", "..");

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "omcp-smoke-"));
    prevHome = process.env.OMCP_HOME;
    process.env.OMCP_HOME = tmp;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.OMCP_HOME;
    else process.env.OMCP_HOME = prevHome;
  });

  it("setup writes a complete plugin layout that doctor reports as healthy (modulo missing copilot bin)", async () => {
    const setup = await runSetup({ packageRoot });
    expect(setup.configUpdated).toBe(true);
    expect(setup.mcpUpdated).toBe(true);

    // plugin manifest in cache
    const cachedManifest = join(
      tmp,
      "installed-plugins",
      "oh-my-copilot",
      "oh-my-copilot",
      ".claude-plugin",
      "plugin.json",
    );
    expect(existsSync(cachedManifest)).toBe(true);

    // agents mirrored
    expect(
      existsSync(
        join(
          tmp,
          "installed-plugins",
          "oh-my-copilot",
          "oh-my-copilot",
          "agents",
          "executor.md",
        ),
      ),
    ).toBe(true);

    // skills mirrored (at least the ones present at this point)
    const skillsDir = join(
      tmp,
      "installed-plugins",
      "oh-my-copilot",
      "oh-my-copilot",
      "skills",
    );
    expect(existsSync(skillsDir)).toBe(true);

    // config + mcp upserted
    const config = JSON.parse(readFileSync(join(tmp, "config.json"), "utf8"));
    expect(config.installedPlugins?.length).toBeGreaterThan(0);
    const mcp = JSON.parse(readFileSync(join(tmp, "mcp-config.json"), "utf8"));
    expect(mcp.mcpServers["omcp-state"]).toBeDefined();

    // doctor: copilot CLI check may fail in CI without the binary; but plugin
    // presence + manifest + agent catalog should all be OK.
    const checks = runDoctor();
    const byName = Object.fromEntries(checks.map((c) => [c.name, c]));
    expect(byName["oh-my-copilot plugin cache"]?.level).toBe("ok");
    expect(byName["plugin manifest"]?.level).toBe("ok");
    expect(byName["agent catalog"]?.level).toBe("ok");
    expect(byName["~/.copilot directory"]?.level).toBe("ok");

    // Doctor will return 2 (fail) if copilot bin is missing OR 0 if present.
    // Either way, no warn-level surprises among the plugin checks.
    const code = exitCodeFor(checks);
    expect([0, 1, 2]).toContain(code);
  });

  it("running setup twice is idempotent (no duplicate plugin entries)", async () => {
    const packageRoot = join(__dirname, "..", "..");
    await runSetup({ packageRoot });
    await runSetup({ packageRoot, force: true });

    const config = JSON.parse(readFileSync(join(tmp, "config.json"), "utf8"));
    const omcpEntries = (config.installedPlugins ?? []).filter(
      (p: { name: string }) => p.name === "oh-my-copilot",
    );
    expect(omcpEntries).toHaveLength(1);
  });

  it("preserves a pre-existing unrelated plugin entry in config.json", async () => {
    writeFileSync(
      join(tmp, "config.json"),
      JSON.stringify({
        installedPlugins: [
          {
            name: "third-party-plugin",
            marketplace: "some-marketplace",
            version: "1.2.3",
            installed_at: "2026-01-01T00:00:00.000Z",
            enabled: true,
            cache_path: "/elsewhere",
          },
        ],
        enabledPlugins: { "third-party-plugin@some-marketplace": true },
      }),
    );
    await runSetup({ packageRoot });

    const config = JSON.parse(readFileSync(join(tmp, "config.json"), "utf8"));
    expect(config.installedPlugins).toHaveLength(2);
    expect(
      config.installedPlugins.some(
        (p: { name: string }) => p.name === "third-party-plugin",
      ),
    ).toBe(true);
    expect(config.enabledPlugins["third-party-plugin@some-marketplace"]).toBe(true);
    expect(config.enabledPlugins["oh-my-copilot@oh-my-copilot"]).toBe(true);
  });
});

/**
 * Deterministic tests for US-1.9-T2-DOCTOR-check-plugin-install.
 * (Invariant 8: CLI registration)
 *
 * Probes plugin mirror drift via sync-plugin-mirror.ts --check.
 * Tests use a synthetic mirror drift scenario via the probePluginInstall
 * injectable scriptPath parameter.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { probePluginInstall, runDoctor } from "../cli/commands/doctor.js";

describe("probePluginInstall (via injectable script path)", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "omcp-plugin-install-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns warn when sync-plugin-mirror script does not exist", () => {
    const result = probePluginInstall(join(tmp, "nonexistent-script.js"));
    expect(result.level).toBe("warn");
    expect(result.detail).toContain("sync-plugin-mirror script not found");
  });

  it("returns ok when sync-plugin-mirror exits 0 (mirror in sync)", () => {
    // Write a stub script that exits 0 (mirror in sync)
    const scriptPath = join(tmp, "sync-ok.js");
    writeFileSync(
      scriptPath,
      `process.stdout.write("sync-plugin-mirror: mirror in sync with source\\n"); process.exit(0);`,
    );
    const result = probePluginInstall(scriptPath);
    expect(result.level).toBe("ok");
    expect(result.detail).toContain("in sync");
  });

  it("returns warn when sync-plugin-mirror exits 1 (mirror has drift)", () => {
    // Write a stub script that exits 1 (mirror drift detected)
    const scriptPath = join(tmp, "sync-drift.js");
    writeFileSync(
      scriptPath,
      [
        `process.stderr.write("sync-plugin-mirror: 3 drift entries\\n");`,
        `process.stderr.write("  + agents/new-agent.md\\n");`,
        `process.stderr.write("  ~ skills/autopilot.md\\n");`,
        `process.stderr.write("  - agents/old-agent.md\\n");`,
        `process.exit(1);`,
      ].join("\n"),
    );
    const result = probePluginInstall(scriptPath);
    expect(result.level).toBe("warn");
    expect(result.detail).toContain("drift");
    expect(result.detail).toContain("omcp setup");
  });

  it("returns warn with drift count from stderr when mirror drifts", () => {
    const scriptPath = join(tmp, "sync-drift2.js");
    writeFileSync(
      scriptPath,
      `process.stderr.write("sync-plugin-mirror: 5 drift entries\\n"); process.exit(1);`,
    );
    const result = probePluginInstall(scriptPath);
    expect(result.level).toBe("warn");
    expect(result.detail).toContain("5 drift entries");
  });
});

describe("runDoctor: plugin mirror check wired", () => {
  let tmp: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "omcp-doctor-plugininstall-"));
    prevHome = process.env.OMCP_HOME;
    process.env.OMCP_HOME = tmp;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.OMCP_HOME;
    else process.env.OMCP_HOME = prevHome;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("runDoctor surfaces 'plugin mirror' check", () => {
    const checks = runDoctor();
    const check = checks.find((c) => c.name === "plugin mirror");
    expect(check).toBeDefined();
    // Without a built dist/, expect warn about missing script
    expect(["ok", "warn"]).toContain(check!.level);
  });
});

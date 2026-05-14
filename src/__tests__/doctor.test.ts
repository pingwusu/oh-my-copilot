import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { exitCodeFor, runDoctor } from "../cli/commands/doctor.js";

describe("doctor checks", () => {
  let tmp: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "omcp-doctor-"));
    prevHome = process.env.OMCP_HOME;
    process.env.OMCP_HOME = tmp;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.OMCP_HOME;
    else process.env.OMCP_HOME = prevHome;
  });

  it("reports warn level when plugin not installed", () => {
    const checks = runDoctor();
    const pluginCheck = checks.find((c) => c.name === "oh-my-copilot plugin cache");
    expect(pluginCheck?.level).toBe("warn");
  });

  it("reports ok level when plugin and manifest exist", () => {
    const pluginDir = join(tmp, "installed-plugins", "oh-my-copilot", "oh-my-copilot");
    mkdirSync(join(pluginDir, ".claude-plugin"), { recursive: true });
    writeFileSync(
      join(pluginDir, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "oh-my-copilot", version: "0.1.0" }),
    );
    const checks = runDoctor();
    expect(checks.find((c) => c.name === "oh-my-copilot plugin cache")?.level).toBe("ok");
    expect(checks.find((c) => c.name === "plugin manifest")?.level).toBe("ok");
  });

  it("exit code reflects highest severity", () => {
    expect(exitCodeFor([{ name: "x", level: "ok", detail: "" }])).toBe(0);
    expect(exitCodeFor([{ name: "x", level: "warn", detail: "" }])).toBe(1);
    expect(exitCodeFor([{ name: "x", level: "fail", detail: "" }])).toBe(2);
    expect(
      exitCodeFor([
        { name: "a", level: "warn", detail: "" },
        { name: "b", level: "fail", detail: "" },
      ]),
    ).toBe(2);
  });
});

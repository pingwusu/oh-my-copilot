// Deterministic tests for the `omcp doctor` mcp-config integrity check.
//
// US-1.9-T2-DOCTOR-check-mcp-config; Invariant 8: CLI registration.
//
// Tests three scenarios via the pure analyzer (no filesystem mocking for
// the analyzer; filesystem probe tested against tmp dirs):
//   1. Synthetic broken config (missing server script file) → fail
//   2. Synthetic OK config → ok
//   3. Synthetic malformed JSON → fail
//
// Also tests:
//   - runDoctor() surfaces the "mcp-config integrity" check (wiring)
//   - Non-existent command path (absolute) → warn

import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  analyzeMcpConfigFromJson,
  probeMcpConfigIntegrity,
  runDoctor,
} from "../cli/commands/doctor.js";

// ── analyzeMcpConfigFromJson (pure) ──────────────────────────────────────────

describe("analyzeMcpConfigFromJson (pure analyzer)", () => {
  it("returns fail for malformed JSON", () => {
    const result = analyzeMcpConfigFromJson("{not valid json", "/fake/mcp-config.json");
    expect(result.level).toBe("fail");
    expect(result.detail).toContain("not valid JSON");
    expect(result.detail).toContain("/fake/mcp-config.json");
  });

  it("returns ok when mcpServers is absent", () => {
    const result = analyzeMcpConfigFromJson(
      JSON.stringify({ someOtherKey: true }),
      "/fake/mcp-config.json",
    );
    expect(result.level).toBe("ok");
    expect(result.detail).toContain("no mcpServers entries");
  });

  it("returns ok when mcpServers is empty object", () => {
    const result = analyzeMcpConfigFromJson(
      JSON.stringify({ mcpServers: {} }),
      "/fake/mcp-config.json",
    );
    expect(result.level).toBe("ok");
  });

  it("returns ok for config with node command and existing script", () => {
    // Use __filename as the script path so it definitely exists.
    const scriptPath = new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
    const config = {
      mcpServers: {
        "omcp-state": {
          command: "node",
          args: [scriptPath],
        },
      },
    };
    const result = analyzeMcpConfigFromJson(
      JSON.stringify(config),
      "/fake/mcp-config.json",
    );
    expect(result.level).toBe("ok");
    expect(result.detail).toContain("1 mcp server(s) verified");
  });

  it("returns fail when node server references a missing script file", () => {
    const config = {
      mcpServers: {
        "omcp-state": {
          command: "node",
          args: ["/nonexistent/path/to/state-server-main.js"],
        },
      },
    };
    const result = analyzeMcpConfigFromJson(
      JSON.stringify(config),
      "/fake/mcp-config.json",
    );
    expect(result.level).toBe("fail");
    expect(result.detail).toContain("missing script files");
    expect(result.detail).toContain("omcp-state");
  });

  it("returns fail when multiple servers reference missing scripts", () => {
    const config = {
      mcpServers: {
        "omcp-state": {
          command: "node",
          args: ["/nonexistent/state-server-main.js"],
        },
        "omcp-notepad": {
          command: "node",
          args: ["/nonexistent/notepad-server-main.js"],
        },
      },
    };
    const result = analyzeMcpConfigFromJson(
      JSON.stringify(config),
      "/fake/mcp-config.json",
    );
    expect(result.level).toBe("fail");
    expect(result.detail).toMatch(/2\/2/);
  });

  it("returns warn when absolute command path does not exist", () => {
    const config = {
      mcpServers: {
        "third-party": {
          command: "/usr/local/bin/nonexistent-binary",
          args: [],
        },
      },
    };
    const result = analyzeMcpConfigFromJson(
      JSON.stringify(config),
      "/fake/mcp-config.json",
    );
    expect(result.level).toBe("warn");
    expect(result.detail).toContain("non-existent command paths");
    expect(result.detail).toContain("third-party");
  });

  it("skips args check when args[0] is a template variable placeholder", () => {
    // ${PLUGIN_ROOT}/... placeholders are substituted at setup time;
    // before setup they are literal — skip existence check.
    const config = {
      mcpServers: {
        "omcp-state": {
          command: "node",
          args: ["${PLUGIN_ROOT}/dist/mcp/state-server-main.js"],
        },
      },
    };
    const result = analyzeMcpConfigFromJson(
      JSON.stringify(config),
      "/fake/mcp-config.json",
    );
    // Template placeholders are skipped — result should be ok or not fail
    expect(["ok", "warn"]).toContain(result.level);
  });

  it("ok config lists server count in detail", () => {
    // Use import.meta.url path as an existing file
    const scriptPath = new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
    const config = {
      mcpServers: {
        "omcp-state": { command: "node", args: [scriptPath] },
        "omcp-notepad": { command: "node", args: [scriptPath] },
        "omcp-trace": { command: "node", args: [scriptPath] },
      },
    };
    const result = analyzeMcpConfigFromJson(
      JSON.stringify(config),
      "/fake/mcp-config.json",
    );
    expect(result.level).toBe("ok");
    expect(result.detail).toContain("3 mcp server(s)");
  });
});

// ── probeMcpConfigIntegrity (filesystem probe) ────────────────────────────────

describe("probeMcpConfigIntegrity (filesystem probe)", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "omcp-doctor-mcp-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns ok when mcp-config.json does not exist", () => {
    const result = probeMcpConfigIntegrity(join(tmp, "mcp-config.json"));
    expect(result.level).toBe("ok");
    expect(result.detail).toContain("no mcp-config.json present");
  });

  it("returns fail for malformed JSON in mcp-config.json", () => {
    const mcpPath = join(tmp, "mcp-config.json");
    writeFileSync(mcpPath, "{ broken json }");
    const result = probeMcpConfigIntegrity(mcpPath);
    expect(result.level).toBe("fail");
    expect(result.detail).toContain("not valid JSON");
  });

  it("returns fail when server references a missing script file", () => {
    const mcpPath = join(tmp, "mcp-config.json");
    writeFileSync(
      mcpPath,
      JSON.stringify({
        mcpServers: {
          "omcp-state": {
            command: "node",
            args: [join(tmp, "does-not-exist.js")],
          },
        },
      }),
    );
    const result = probeMcpConfigIntegrity(mcpPath);
    expect(result.level).toBe("fail");
    expect(result.detail).toContain("missing script files");
  });

  it("returns ok when server script exists", () => {
    const scriptPath = join(tmp, "state-server-main.js");
    writeFileSync(scriptPath, "// stub");
    const mcpPath = join(tmp, "mcp-config.json");
    writeFileSync(
      mcpPath,
      JSON.stringify({
        mcpServers: {
          "omcp-state": {
            command: "node",
            args: [scriptPath],
          },
        },
      }),
    );
    const result = probeMcpConfigIntegrity(mcpPath);
    expect(result.level).toBe("ok");
    expect(result.detail).toContain("verified");
  });

  it("returns ok when no mcpServers key present", () => {
    const mcpPath = join(tmp, "mcp-config.json");
    writeFileSync(mcpPath, JSON.stringify({ someOtherKey: 42 }));
    const result = probeMcpConfigIntegrity(mcpPath);
    expect(result.level).toBe("ok");
  });
});

// ── runDoctor wiring: "mcp-config integrity" check is surfaced ────────────────

describe("runDoctor: mcp-config integrity check wired", () => {
  let tmp: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "omcp-doctor-mcp-wire-"));
    prevHome = process.env.OMCP_HOME;
    process.env.OMCP_HOME = tmp;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.OMCP_HOME;
    else process.env.OMCP_HOME = prevHome;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("runDoctor surfaces 'mcp-config integrity' check (absent mcp-config → ok)", () => {
    const checks = runDoctor();
    const mcpCheck = checks.find((c) => c.name === "mcp-config integrity");
    expect(mcpCheck).toBeDefined();
    expect(mcpCheck!.level).toBe("ok");
    expect(mcpCheck!.detail).toContain("no mcp-config.json present");
  });

  it("runDoctor surfaces 'mcp-config integrity' fail for malformed config", () => {
    writeFileSync(join(tmp, "mcp-config.json"), "not json at all");
    const checks = runDoctor();
    const mcpCheck = checks.find((c) => c.name === "mcp-config integrity");
    expect(mcpCheck).toBeDefined();
    expect(mcpCheck!.level).toBe("fail");
    expect(mcpCheck!.detail).toContain("not valid JSON");
  });

  it("runDoctor surfaces 'mcp-config integrity' fail for missing script", () => {
    mkdirSync(join(tmp, "logs"), { recursive: true });
    writeFileSync(
      join(tmp, "mcp-config.json"),
      JSON.stringify({
        mcpServers: {
          "omcp-state": {
            command: "node",
            args: [join(tmp, "nonexistent.js")],
          },
        },
      }),
    );
    const checks = runDoctor();
    const mcpCheck = checks.find((c) => c.name === "mcp-config integrity");
    expect(mcpCheck).toBeDefined();
    expect(mcpCheck!.level).toBe("fail");
  });

  it("runDoctor surfaces 'mcp-config integrity' ok when script exists", () => {
    const scriptPath = join(tmp, "state-server-main.js");
    writeFileSync(scriptPath, "// stub");
    writeFileSync(
      join(tmp, "mcp-config.json"),
      JSON.stringify({
        mcpServers: {
          "omcp-state": { command: "node", args: [scriptPath] },
        },
      }),
    );
    const checks = runDoctor();
    const mcpCheck = checks.find((c) => c.name === "mcp-config integrity");
    expect(mcpCheck).toBeDefined();
    expect(mcpCheck!.level).toBe("ok");
  });
});

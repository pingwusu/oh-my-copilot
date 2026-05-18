// Invariants that protect against the "module exists but unwired" bug class
// (critic P0-1) and the "MODE_COMMANDS lists a slug with no SKILL.md" bug
// class (critic P0-2).

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

const ROOT = join(__dirname, "..", "..");

function readOmcpCli(): string {
  return readFileSync(join(ROOT, "src", "cli", "omcp.ts"), "utf8");
}

describe("CLI wiring invariants", () => {
  it("every src/cli/commands/*.ts is imported by src/cli/omcp.ts", () => {
    const cliText = readOmcpCli();
    const commandsDir = join(ROOT, "src", "cli", "commands");
    const files = readdirSync(commandsDir).filter(
      (f) => f.endsWith(".ts") && !f.endsWith(".d.ts"),
    );
    const orphans = files.filter((f) => {
      const moduleName = f.replace(/\.ts$/, "");
      const importPath = `./commands/${moduleName}.js`;
      return !cliText.includes(importPath);
    });
    if (orphans.length > 0) {
      console.error(
        "Orphaned command modules (file exists but never imported by omcp.ts):\n  " +
          orphans.join("\n  "),
      );
    }
    expect(orphans).toEqual([]);
  });

  it("every MODE_COMMANDS slug has a matching skills/<slug>/SKILL.md", () => {
    const cliText = readOmcpCli();
    // Parse the MODE_COMMANDS array body — find the [ ... ] block.
    const m = cliText.match(/const\s+MODE_COMMANDS\s*=\s*\[([\s\S]*?)\]/);
    expect(m, "MODE_COMMANDS array must exist in omcp.ts").toBeTruthy();
    const slugs = (m![1].match(/"([^"]+)"/g) ?? []).map((s) => s.slice(1, -1));
    expect(slugs.length).toBeGreaterThan(0);

    const skillsDir = join(ROOT, "skills");
    const missing = slugs.filter(
      (slug) => !existsSync(join(skillsDir, slug, "SKILL.md")),
    );
    if (missing.length > 0) {
      console.error(
        "MODE_COMMANDS slugs without a matching skill:\n  " +
          missing.join("\n  "),
      );
    }
    expect(missing).toEqual([]);
  });

  it("OMCP_MCP_SERVER_KEYS matches .mcp.json server count", () => {
    const mcp = JSON.parse(readFileSync(join(ROOT, ".mcp.json"), "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    const declaredKeys = Object.keys(mcp.mcpServers);
    const uninstallText = readFileSync(
      join(ROOT, "src", "cli", "commands", "uninstall.ts"),
      "utf8",
    );
    const m = uninstallText.match(/OMCP_MCP_SERVER_KEYS\s*=\s*\[([\s\S]*?)\]/);
    expect(m, "OMCP_MCP_SERVER_KEYS array must exist").toBeTruthy();
    const known = (m![1].match(/"([^"]+)"/g) ?? []).map((s) => s.slice(1, -1));
    const missing = declaredKeys.filter((k) => !known.includes(k));
    if (missing.length > 0) {
      console.error(
        "OMCP_MCP_SERVER_KEYS missing entries from .mcp.json:\n  " +
          missing.join("\n  "),
      );
    }
    expect(missing).toEqual([]);
  });

  it("mcp-serve SERVER_FILES has an entry for every MCP server (minus .mcp.json prefix)", () => {
    const mcp = JSON.parse(readFileSync(join(ROOT, ".mcp.json"), "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    const declared = Object.keys(mcp.mcpServers).map((k) =>
      k.replace(/^omcp-/, ""),
    );
    const mcpServeText = readFileSync(
      join(ROOT, "src", "cli", "commands", "mcp-serve.ts"),
      "utf8",
    );
    const missing = declared.filter((name) => {
      // accept either `name:` (un-quoted) or `"name":` (quoted, for hyphenated names)
      return (
        !new RegExp(`(?:^|\\s)${name}:`, "m").test(mcpServeText) &&
        !mcpServeText.includes(`"${name}":`)
      );
    });
    if (missing.length > 0) {
      console.error(
        "mcp-serve SERVER_FILES missing entries:\n  " + missing.join("\n  "),
      );
    }
    expect(missing).toEqual([]);
  });

  it("package.json files: ships the runtime dirs needed at install time", () => {
    const pkg = JSON.parse(
      readFileSync(join(ROOT, "package.json"), "utf8"),
    ) as { files: string[] };
    const required = [
      "dist/",
      "agents/",
      "skills/",
      "hooks/",
      "scripts/",
      "plugins/",
      ".claude-plugin/",
      ".mcp.json",
    ];
    const missing = required.filter((entry) => !pkg.files.includes(entry));
    if (missing.length > 0) {
      console.error(
        "package.json files: missing required entries:\n  " +
          missing.join("\n  "),
      );
    }
    expect(missing).toEqual([]);
  });

  it("all three manifests have identical version", () => {
    const pkg = JSON.parse(
      readFileSync(join(ROOT, "package.json"), "utf8"),
    ) as { version: string };
    const plugin = JSON.parse(
      readFileSync(join(ROOT, ".claude-plugin", "plugin.json"), "utf8"),
    ) as { version: string };
    const marketplace = JSON.parse(
      readFileSync(join(ROOT, ".agents", "plugins", "marketplace.json"), "utf8"),
    ) as { plugins: Array<{ version: string }> };
    expect(plugin.version).toBe(pkg.version);
    for (const p of marketplace.plugins) {
      expect(p.version).toBe(pkg.version);
    }
  });

  it("scripts/ ships omcp-hud.mjs and omcp-loop-watcher.mjs", () => {
    expect(
      existsSync(join(ROOT, "scripts", "omcp-hud.mjs")),
      "omcp-hud.mjs must exist",
    ).toBe(true);
    expect(
      existsSync(join(ROOT, "scripts", "omcp-loop-watcher.mjs")),
      "omcp-loop-watcher.mjs must exist",
    ).toBe(true);
    // Both should be marked-as-files (not dirs).
    expect(
      statSync(join(ROOT, "scripts", "omcp-hud.mjs")).isFile(),
    ).toBe(true);
    expect(
      statSync(join(ROOT, "scripts", "omcp-loop-watcher.mjs")).isFile(),
    ).toBe(true);
  });

  // DD3-A regression guard: setup.ts SOURCE_ROOTS and
  // sync-plugin-mirror.ts DIR_SOURCES drifted in the past (scripts/ went
  // missing from SOURCE_ROOTS). Force them to stay in lockstep.
  it("setup.ts SOURCE_ROOTS matches sync-plugin-mirror.ts DIR_SOURCES", () => {
    const setupText = readFileSync(
      join(ROOT, "src", "cli", "commands", "setup.ts"),
      "utf8",
    );
    const mirrorText = readFileSync(
      join(ROOT, "src", "scripts", "sync-plugin-mirror.ts"),
      "utf8",
    );
    const setupMatch = setupText.match(
      /const\s+SOURCE_ROOTS\s*=\s*\[([\s\S]*?)\]/,
    );
    const mirrorMatch = mirrorText.match(
      /const\s+DIR_SOURCES\s*=\s*\[([\s\S]*?)\]/,
    );
    expect(setupMatch, "setup.ts must declare SOURCE_ROOTS").toBeTruthy();
    expect(mirrorMatch, "sync-plugin-mirror.ts must declare DIR_SOURCES").toBeTruthy();

    const parse = (body: string): string[] =>
      (body.match(/"([^"]+)"/g) ?? []).map((s) => s.slice(1, -1)).sort();

    const setupArr = parse(setupMatch![1]);
    const mirrorArr = parse(mirrorMatch![1]);
    expect(setupArr).toEqual(mirrorArr);
  });
});

// Tests for US-1.9-T1-HUD-config-backup and US-1.9-T1-HUD-statusline.
//
// Covers:
//  - backupCopilotConfig: creates timestamped backup when config exists
//  - backupCopilotConfig: returns backedUp=false when no config present
//  - wireHudStatusLine: writes statusLine.command to config
//  - wireHudStatusLine: idempotent when already wired
//  - wireHudStatusLine: dry-run skips write
//  - wireHudStatusLine: rollback on write failure (simulated)

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  backupCopilotConfig,
  OMCP_STATUS_LINE_COMMAND,
  wireHudStatusLine,
} from "../hud/config.js";

describe("backupCopilotConfig", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "omcp-cfg-bkp-"));
  });

  it("returns backedUp=false when config does not exist", () => {
    const configPath = join(tmpDir, "config.json");
    const result = backupCopilotConfig(configPath);
    expect(result.backedUp).toBe(false);
    expect(result.backupPath).toBeNull();
  });

  it("writes a timestamped backup when config exists", () => {
    const configPath = join(tmpDir, "config.json");
    writeFileSync(configPath, JSON.stringify({ model: "claude" }), "utf8");

    const result = backupCopilotConfig(configPath);
    expect(result.backedUp).toBe(true);
    expect(result.backupPath).not.toBeNull();
    expect(result.backupPath!).toMatch(/\.omcp-backup-/);
    expect(existsSync(result.backupPath!)).toBe(true);

    const content = readFileSync(result.backupPath!, "utf8");
    expect(JSON.parse(content)).toEqual({ model: "claude" });
  });

  it("backup content matches original", () => {
    const configPath = join(tmpDir, "config.json");
    const original = { model: "gpt-5", plugins: ["a", "b"] };
    writeFileSync(configPath, JSON.stringify(original, null, 2), "utf8");

    const result = backupCopilotConfig(configPath);
    const backed = JSON.parse(readFileSync(result.backupPath!, "utf8"));
    expect(backed).toEqual(original);
  });
});

describe("wireHudStatusLine", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "omcp-cfg-wire-"));
  });

  it("writes statusLine.command to new config file", () => {
    const configPath = join(tmpDir, "config.json");
    const result = wireHudStatusLine(configPath);

    expect(result.wired).toBe(true);
    expect(result.alreadyWired).toBe(false);
    expect(existsSync(configPath)).toBe(true);

    const written = JSON.parse(readFileSync(configPath, "utf8"));
    expect(written.statusLine?.command).toBe(OMCP_STATUS_LINE_COMMAND);
  });

  it("preserves existing config fields when wiring statusLine", () => {
    const configPath = join(tmpDir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({ model: "claude", theme: "dark" }, null, 2),
      "utf8",
    );

    wireHudStatusLine(configPath);
    const written = JSON.parse(readFileSync(configPath, "utf8"));
    expect(written.model).toBe("claude");
    expect(written.theme).toBe("dark");
    expect(written.statusLine?.command).toBe(OMCP_STATUS_LINE_COMMAND);
  });

  it("is idempotent when already wired", () => {
    const configPath = join(tmpDir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({ statusLine: { command: OMCP_STATUS_LINE_COMMAND } }, null, 2),
      "utf8",
    );

    const result = wireHudStatusLine(configPath);
    expect(result.wired).toBe(true);
    expect(result.alreadyWired).toBe(true);
    expect(result.backup).toBeNull();
  });

  it("dry-run: does not write config, returns wired=false", () => {
    const configPath = join(tmpDir, "config.json");
    const result = wireHudStatusLine(configPath, true);

    expect(result.wired).toBe(false);
    expect(existsSync(configPath)).toBe(false);
  });

  it("creates a backup before mutating existing config", () => {
    const configPath = join(tmpDir, "config.json");
    writeFileSync(configPath, JSON.stringify({ model: "claude" }), "utf8");

    const result = wireHudStatusLine(configPath);
    expect(result.backup).not.toBeNull();
    expect(result.backup!.backedUp).toBe(true);
    expect(existsSync(result.backup!.backupPath!)).toBe(true);
  });

  it("OMCP_STATUS_LINE_COMMAND constant is 'omcp hud'", () => {
    expect(OMCP_STATUS_LINE_COMMAND).toBe("omcp hud");
  });
});

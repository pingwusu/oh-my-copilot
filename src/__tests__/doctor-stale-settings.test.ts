/**
 * Deterministic tests for v1.7 US-06: omcp doctor stale-settings check.
 *
 * Background (v1.4 RCA): the L1.2 wrapper-script revert (c7cbc21)
 * deleted scripts/omcp-hook-dispatch.cjs but never refreshed
 * ~/.copilot/settings.json. All 13 hook entries kept pointing to the
 * deleted file. L3.6 smoke surfaced "3/3 Stop handlers exit code 1"
 * as a downstream symptom.
 *
 * v1.7 doctor check 10 catches this BEFORE runtime by scanning each
 * omcp-owned (__omcp:true) hook command's referenced script path and
 * verifying existsSync. Pure analyzer is testable without filesystem
 * via JSON input; filesystem probe is tested against tmp files.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  analyzeStaleSettingsFromJson,
  probeStaleSettings,
} from "../cli/commands/doctor.js";

describe("analyzeStaleSettingsFromJson (pure)", () => {
  it("returns ok when settings.json has no hook entries", () => {
    const result = analyzeStaleSettingsFromJson(`{}`, "/fake/settings.json");
    expect(result.level).toBe("ok");
    expect(result.detail).toContain("no hook entries");
  });

  it("returns ok when no omcp-owned (__omcp:true) entries present", () => {
    const json = JSON.stringify({
      hooks: {
        Stop: [
          {
            matcher: "*",
            hooks: [{ type: "command", command: "echo user-custom" }],
          },
        ],
      },
    });
    const result = analyzeStaleSettingsFromJson(json, "x");
    expect(result.level).toBe("ok");
    expect(result.detail).toContain("no omcp-owned");
  });

  it("returns warn when settings.json is invalid JSON", () => {
    const result = analyzeStaleSettingsFromJson(
      "{ not valid json }",
      "/fake/path",
    );
    expect(result.level).toBe("warn");
    expect(result.detail).toMatch(/not valid JSON/);
    expect(result.detail).toContain("/fake/path");
  });

  it("returns ok when omcp entries reference existing scripts (uses node real-path)", () => {
    // Use this test file itself as a known-to-exist path.
    const realPath = __filename;
    const json = JSON.stringify({
      hooks: {
        Stop: [
          {
            matcher: "*",
            hooks: [
              {
                type: "command",
                command: `node "${realPath}" hook fire Stop --json`,
                __omcp: true,
              },
            ],
          },
        ],
      },
    });
    const result = analyzeStaleSettingsFromJson(json, "x");
    expect(result.level).toBe("ok");
    expect(result.detail).toMatch(/1 omcp hook entries verified/);
  });

  it("returns warn when omcp entry references missing script (the v1.4 RCA scenario)", () => {
    const missingPath = "C:\\nonexistent\\stale-dispatch.cjs";
    const json = JSON.stringify({
      hooks: {
        Stop: [
          {
            matcher: "*",
            hooks: [
              {
                type: "command",
                command: `node "${missingPath}" hook fire Stop --json`,
                __omcp: true,
              },
            ],
          },
        ],
      },
    });
    const result = analyzeStaleSettingsFromJson(json, "x");
    expect(result.level).toBe("warn");
    expect(result.detail).toMatch(/1\/1 omcp hook entries reference missing/);
    expect(result.detail).toMatch(/stale-dispatch\.cjs/);
    expect(result.detail).toMatch(/omcp setup/);
  });

  it("returns warn with truncated sample when many entries stale (>3)", () => {
    const missingBase = "C:\\nonexistent\\missing";
    const events = ["Stop", "SessionEnd", "PreToolUse", "PostToolUse", "Notification"];
    const json = JSON.stringify({
      hooks: Object.fromEntries(
        events.map((event, i) => [
          event,
          [
            {
              matcher: "*",
              hooks: [
                {
                  type: "command",
                  command: `node "${missingBase}-${i}.cjs" hook fire ${event} --json`,
                  __omcp: true,
                },
              ],
            },
          ],
        ]),
      ),
    });
    const result = analyzeStaleSettingsFromJson(json, "x");
    expect(result.level).toBe("warn");
    expect(result.detail).toMatch(/5\/5/);
    expect(result.detail).toMatch(/\.\.\./);
  });

  it("does NOT flag entries without __omcp:true (user-authored hooks left alone)", () => {
    const missingPath = "C:\\nonexistent\\user-script.cjs";
    const json = JSON.stringify({
      hooks: {
        Stop: [
          {
            matcher: "*",
            hooks: [
              {
                type: "command",
                command: `node "${missingPath}"`,
                // No __omcp flag — user-authored.
              },
            ],
          },
        ],
      },
    });
    const result = analyzeStaleSettingsFromJson(json, "x");
    // User-authored hook with missing path is the user's problem;
    // doctor's stale-settings probe is scoped to omcp-owned entries.
    expect(result.level).toBe("ok");
    expect(result.detail).toContain("no omcp-owned");
  });
});

describe("probeStaleSettings (filesystem)", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "omcp-stale-settings-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns ok when settings.json does not exist", () => {
    const result = probeStaleSettings(join(tmp, "settings.json"));
    expect(result.level).toBe("ok");
    expect(result.detail).toContain("no settings.json yet");
  });

  it("e2e: writes a stale settings.json + probe surfaces it", () => {
    const settingsPath = join(tmp, "settings.json");
    writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          Stop: [
            {
              matcher: "*",
              hooks: [
                {
                  type: "command",
                  command: `node "${join(tmp, "deleted-script.cjs")}" hook fire Stop --json`,
                  __omcp: true,
                },
              ],
            },
          ],
        },
      }),
    );
    const result = probeStaleSettings(settingsPath);
    expect(result.level).toBe("warn");
    expect(result.detail).toMatch(/deleted-script\.cjs/);
  });
});

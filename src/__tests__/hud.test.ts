import { describe, it, expect, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const HUD = resolve(HERE, "..", "..", "scripts", "omcp-hud.mjs");

function runHud(cwd: string, extraEnv: Record<string, string> = {}): {
  stdout: string;
  code: number;
} {
  let stdout = "";
  let code = 0;
  try {
    stdout = execFileSync(process.execPath, [HUD], {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        // Force defaults to be deterministic.
        OMCP_HOME: join(cwd, ".no-such-copilot"),
        OMCP_PLUGIN_ROOT: join(cwd, ".no-such-plugin"),
        OMCP_MODEL_FAMILY: "",
        ...extraEnv,
      },
    });
  } catch (err) {
    const e = err as { status?: number; stdout?: string | Buffer };
    code = typeof e.status === "number" ? e.status : 1;
    stdout = e.stdout
      ? typeof e.stdout === "string"
        ? e.stdout
        : e.stdout.toString("utf8")
      : "";
  }
  return { stdout: stdout.toString(), code };
}

describe("omcp HUD", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "omcp-hud-"));
  });

  it("exits 0 and prints a single line with no state", () => {
    const { stdout, code } = runHud(cwd);
    expect(code).toBe(0);
    expect(stdout.split("\n").filter((l) => l.length > 0)).toHaveLength(1);
    expect(stdout.startsWith("omcp")).toBe(true);
  });

  it("includes model family from OMCP_MODEL_FAMILY", () => {
    const { stdout, code } = runHud(cwd, { OMCP_MODEL_FAMILY: "gpt" });
    expect(code).toBe(0);
    expect(stdout).toContain("gpt");
  });

  it("includes active modes from mode.json", () => {
    const stateDir = join(cwd, ".omcp", "state");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, "mode.json"),
      JSON.stringify({ modes: ["ralph", "autopilot"] }),
      "utf8",
    );

    const { stdout, code } = runHud(cwd);
    expect(code).toBe(0);
    expect(stdout).toContain("ralph,autopilot");
  });

  it("includes ralph iter/max and team agentsDone/spawned", () => {
    const stateDir = join(cwd, ".omcp", "state");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, "ralph.json"),
      JSON.stringify({ iter: 3, max: 10 }),
      "utf8",
    );
    writeFileSync(
      join(stateDir, "team.json"),
      JSON.stringify({ agentsDone: 2, spawned: 5 }),
      "utf8",
    );

    const { stdout, code } = runHud(cwd);
    expect(code).toBe(0);
    expect(stdout).toContain("3/10");
    expect(stdout).toContain("2/5");
  });

  it("includes priority note from notepad.md (first non-empty line, truncated)", () => {
    mkdirSync(join(cwd, ".omcp"), { recursive: true });
    writeFileSync(
      join(cwd, ".omcp", "notepad.md"),
      "\n\n# Top priority note here\nsecond line\n",
      "utf8",
    );
    const { stdout, code } = runHud(cwd);
    expect(code).toBe(0);
    expect(stdout).toContain("Top priority note here");
  });

  it("truncates long notes to 60 chars", () => {
    mkdirSync(join(cwd, ".omcp"), { recursive: true });
    const long = "x".repeat(120);
    writeFileSync(join(cwd, ".omcp", "notepad.md"), `${long}\n`, "utf8");
    const { stdout, code } = runHud(cwd);
    expect(code).toBe(0);
    // Truncated string must appear (60 chars including the ellipsis).
    const line = stdout.trim();
    // The displayed note part should be <= 60 chars.
    const parts = line.split(" · ");
    const notePart = parts[parts.length - 1];
    expect(notePart.length).toBeLessThanOrEqual(60);
  });

  it("degrades gracefully when state files are malformed", () => {
    const stateDir = join(cwd, ".omcp", "state");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "mode.json"), "{not json", "utf8");
    writeFileSync(join(stateDir, "ralph.json"), "{not json", "utf8");
    const { stdout, code } = runHud(cwd);
    expect(code).toBe(0);
    expect(stdout.startsWith("omcp")).toBe(true);
  });
});

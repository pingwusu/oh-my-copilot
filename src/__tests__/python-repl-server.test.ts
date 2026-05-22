// Tests for python_repl handler. Skipped when python is unavailable.

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { runPython, trySpawn } from "../mcp/python-repl-server.js";

// Detect python availability once at module load time.
function detectPython(): string | null {
  for (const cmd of ["python3", "python"]) {
    try {
      const r = spawnSync(cmd, ["-c", "import sys; sys.exit(0)"], { encoding: "utf8" });
      if (r.status === 0) return cmd;
    } catch {
      // binary not found
    }
  }
  return null;
}

const pythonBin = detectPython();

describe("python_repl", () => {
  it.skipIf(!pythonBin)("print(1+1) returns stdout '2\\n'", async () => {
    const result = await runPython("print(1+1)", 10_000);
    expect(result.stdout.replace(/\r\n/g, "\n")).toBe("2\n");
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  it.skipIf(!pythonBin)("sys.exit(2) returns exitCode 2", async () => {
    const result = await runPython("import sys; sys.exit(2)", 10_000);
    expect(result.exitCode).toBe(2);
    expect(result.timedOut).toBe(false);
  });

  it.skipIf(!pythonBin)("infinite loop with 500 ms timeout returns timedOut: true", async () => {
    const result = await runPython("while True: pass", 500);
    expect(result.timedOut).toBe(true);
  }, 5_000);

  it("returns null from trySpawn when binary is absent (ENOENT path)", async () => {
    const result = await trySpawn("__nonexistent_python_binary__", "print(1)", 5_000);
    expect(result).toBeNull();
  });
});

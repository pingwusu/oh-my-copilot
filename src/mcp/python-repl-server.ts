#!/usr/bin/env node
// omcp python-repl MCP server — exposes python_repl.
// Spawns python3 first, falls back to python, with -c <code>.
// No shell interpolation: spawn(cmd, ["-c", code]) — code is never string-interpolated.

import { spawn } from "node:child_process";
import { runMcpServer } from "./server-runtime.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;

// Windows Store stub for python3 exits with 9009 when Python is not installed.
// Treat this as "binary not found" so we fall through to the next candidate.
const WINDOWS_STORE_STUB_EXIT = 9009;

export interface PythonResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

/** Try one candidate binary. Returns null if the binary is not found. */
export function trySpawn(cmd: string, code: string, timeoutMs: number): Promise<PythonResult | null> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, ["-c", code], { stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      resolve(null);
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let resolved = false;

    const done = (result: PythonResult | null) => {
      if (resolved) return;
      resolved = true;
      resolve(result);
    };

    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });

    child.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        done(null);
      } else {
        done({ stdout, stderr: stderr + err.message, exitCode: -1, timedOut: false });
      }
    });

    child.on("close", (code) => {
      // Windows Store stub for python3 exits 9009 — treat as not-found.
      if (code === WINDOWS_STORE_STUB_EXIT && stdout === "" && !timedOut) {
        done(null);
        return;
      }
      done({ stdout, stderr, exitCode: code ?? -1, timedOut });
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill(); } catch { /* ignore */ }
      // On Windows, child.kill() may not terminate Python subprocesses.
      // Give the process a short grace period after SIGTERM before resolving.
      done({ stdout, stderr, exitCode: -1, timedOut: true });
    }, timeoutMs);

    if (timer.unref) timer.unref();
  });
}

export async function runPython(code: string, timeoutMs: number): Promise<PythonResult> {
  for (const cmd of ["python3", "python"]) {
    const result = await trySpawn(cmd, code, timeoutMs);
    if (result !== null) return result;
  }
  return { stdout: "", stderr: "Python not found in PATH", exitCode: -1, timedOut: false };
}

runMcpServer({
  name: "omcp-python-repl",
  version: "0.1.0",
  tools: [
    {
      name: "python_repl",
      description:
        "Execute a Python snippet. Spawns python3/python with -c <code>. " +
        "Returns { stdout, stderr, exitCode, timedOut }. " +
        "Default timeout 30 s; max 120 s.",
      inputSchema: {
        type: "object",
        properties: {
          code: { type: "string", description: "Python code to execute." },
          timeout_ms: {
            type: "number",
            description: `Timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}).`,
          },
        },
        required: ["code"],
      },
      handler: async (args) => {
        const code = args.code as string;
        const raw = typeof args.timeout_ms === "number" ? args.timeout_ms : DEFAULT_TIMEOUT_MS;
        const timeoutMs = Math.min(Math.max(raw, 1), MAX_TIMEOUT_MS);
        return runPython(code, timeoutMs);
      },
    },
  ],
}).catch((err) => {
  console.error(err);
  process.exit(1);
});

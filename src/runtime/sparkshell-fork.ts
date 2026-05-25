/**
 * sparkshell-fork.ts — Direction C: Node child_process.fork IPC dispatcher.
 *
 * Compensates for Copilot CLI pwsh dispatch limitations on Windows by using
 * Node's built-in IPC channel instead of stdio framing. The parent process
 * forks a worker that loads omcp's hook-fire logic directly, sends the
 * event payload over the IPC channel, and receives the result back.
 *
 * Invariant 4: only events in COPILOT_VALID_EVENTS may be dispatched.
 * The caller is responsible for passing a valid event name; this module
 * validates before forking and throws if the event is unknown.
 *
 * Architecture note: fork IPC avoids the shell-quoting hazards that affect
 * direction A (Rust) and direction B (.cmd) on Windows — the payload is
 * transferred as a structured JS object, not serialised through a shell argv.
 */

import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { COPILOT_VALID_EVENTS } from "./copilot-config.js";

export type SparkshellEvent = (typeof COPILOT_VALID_EVENTS)[number];

export interface SparkshellForkOptions {
  /**
   * Absolute path to the worker module.  Defaults to
   * `<this-file's-dir>/sparkshell-fork-worker.js` in dist (set by build).
   * Override in tests to point at the test fixture worker.
   */
  workerPath?: string;
  /** Timeout in ms before the fork is killed.  Default: 10_000. */
  timeoutMs?: number;
}

export interface SparkshellForkResult {
  exitCode: number;
  output: unknown;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Dispatch a Copilot hook event via a forked Node worker over IPC.
 *
 * @param event   - A valid COPILOT_VALID_EVENTS name (Invariant 4).
 * @param payload - Raw JSON payload from Copilot CLI stdin.
 * @param opts    - Optional path/timeout overrides.
 * @returns       - Resolved with the worker's result message and exit code.
 */
export async function dispatchViaFork(
  event: string,
  payload: Record<string, unknown>,
  opts: SparkshellForkOptions = {},
): Promise<SparkshellForkResult> {
  // Invariant 4: validate event before spawning.
  if (!(COPILOT_VALID_EVENTS as readonly string[]).includes(event)) {
    throw new Error(
      `sparkshell-fork: unknown event "${event}". Must be one of: ${COPILOT_VALID_EVENTS.join(", ")}`,
    );
  }

  const workerPath =
    opts.workerPath ??
    resolve(__dirname, "sparkshell-fork-worker.js");

  const timeoutMs = opts.timeoutMs ?? 10_000;

  return new Promise<SparkshellForkResult>((resolveP, rejectP) => {
    const child = fork(workerPath, [], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });

    let output: unknown = null;
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGTERM");
        rejectP(new Error(`sparkshell-fork: worker timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    child.on("message", (msg: unknown) => {
      output = msg;
    });

    child.on("close", (code: number | null) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        resolveP({ exitCode: code ?? 1, output });
      }
    });

    child.on("error", (err: Error) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        rejectP(err);
      }
    });

    // Send the event + payload to the worker once the IPC channel is ready.
    child.send({ event, payload });
  });
}

/**
 * sparkshell-direction-fork.test.ts — deterministic tests for direction C.
 *
 * US-1.9-T3-SPARKSHELL-direction-fork
 * Invariants cited: I4 (valid events), I9 (no orphan workers — fork is awaited)
 *
 * Strategy: call dispatchViaFork() with a test-fixture worker (not the real
 * sparkshell-fork-worker.ts) to keep tests deterministic and fast.
 * The fixture worker simply echoes back the message it receives via IPC.
 *
 * We also test dispatchViaFork() directly to verify:
 *  1. Invalid event names are rejected before forking (I4).
 *  2. Valid event + payload round-trips through IPC.
 *  3. Timeout fires correctly.
 *  4. Worker exit code is propagated.
 */

import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dispatchViaFork } from "../runtime/sparkshell-fork.js";

let tmp: string;
let echoWorker: string;
let slowWorker: string;
let exitOneWorker: string;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "omcp-sparkshell-fork-"));

  // echo worker: sends the received message back, exits 0.
  echoWorker = join(tmp, "echo-worker.mjs");
  writeFileSync(
    echoWorker,
    [
      "process.on('message', (msg) => {",
      "  process.send({ kind: 'echo', received: msg });",
      "  process.exit(0);",
      "});",
    ].join("\n"),
    "utf8",
  );

  // slow worker: never responds (triggers timeout).
  slowWorker = join(tmp, "slow-worker.mjs");
  writeFileSync(
    slowWorker,
    "// intentionally hangs\nprocess.on('message', () => { /* no response */ });",
    "utf8",
  );

  // exit-1 worker: exits with code 1 without sending a message.
  exitOneWorker = join(tmp, "exit-one-worker.mjs");
  writeFileSync(
    exitOneWorker,
    "process.on('message', () => { process.exit(1); });",
    "utf8",
  );
});

afterAll(() => {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
});

describe("sparkshell direction-C (Node fork IPC wrapper)", () => {
  describe("Invariant 4 — invalid events rejected before forking", () => {
    it("throws for an unknown event name", async () => {
      await expect(
        dispatchViaFork("NotARealEvent", {}, { workerPath: echoWorker }),
      ).rejects.toThrow(/unknown event "NotARealEvent"/);
    });

    it("throws for an empty string event", async () => {
      await expect(
        dispatchViaFork("", {}, { workerPath: echoWorker }),
      ).rejects.toThrow(/unknown event ""/);
    });
  });

  describe("IPC payload round-trip", () => {
    it("sends event + payload to worker and receives echoed result", async () => {
      const payload = { sessionId: "test-session-1", cwd: "/tmp/project" };
      const result = await dispatchViaFork("subagentStart", payload, {
        workerPath: echoWorker,
      });
      expect(result.exitCode).toBe(0);
      expect(result.output).toMatchObject({
        kind: "echo",
        received: { event: "subagentStart", payload },
      });
    });

    it("forwards the full payload object including nested fields", async () => {
      const payload = {
        sessionId: "nested-test",
        cwd: "/some/path",
        tool_name: "Bash",
        tool_args: { command: "ls -la" },
      };
      const result = await dispatchViaFork("preToolUse", payload, {
        workerPath: echoWorker,
      });
      expect(result.exitCode).toBe(0);
      const echo = result.output as {
        received: { payload: typeof payload };
      };
      expect(echo.received.payload.tool_name).toBe("Bash");
      expect(echo.received.payload.tool_args).toEqual({ command: "ls -la" });
    });

    it("works with all three sample valid events", async () => {
      const events = ["sessionStart", "agentStop", "postToolUse"] as const;
      for (const event of events) {
        const result = await dispatchViaFork(
          event,
          { sessionId: `s-${event}`, cwd: "/tmp" },
          { workerPath: echoWorker },
        );
        expect(result.exitCode).toBe(0);
        const echo = result.output as { received: { event: string } };
        expect(echo.received.event).toBe(event);
      }
    });
  });

  describe("exit code propagation", () => {
    it("propagates non-zero exit code from worker", async () => {
      const result = await dispatchViaFork("sessionEnd", {}, {
        workerPath: exitOneWorker,
      });
      expect(result.exitCode).toBe(1);
      // output is null because the worker never sent a message
      expect(result.output).toBeNull();
    });
  });

  describe("timeout handling", () => {
    it("rejects with timeout error when worker does not respond in time", async () => {
      await expect(
        dispatchViaFork("subagentStop", {}, {
          workerPath: slowWorker,
          timeoutMs: 500,
        }),
      ).rejects.toThrow(/timed out after 500ms/);
    });
  });
});

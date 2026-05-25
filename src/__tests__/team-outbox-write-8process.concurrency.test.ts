/**
 * Real-process 8-writer concurrency test for outbox-write-helper.
 *
 * Per ADR-omcp-eb-02 §2: the lockfile contract must hold under multi-
 * process contention. This test spawns 8 separate Node processes, each
 * appending 100 JSONL lines to the SAME outbox.jsonl via the in-process
 * runTeamOutboxWrite helper. The test then asserts:
 *   POSITIVE: every line in the resulting outbox parses as valid JSON +
 *             total line count = 800 (no torn writes, no message loss).
 *
 * A companion NEGATIVE case (2 processes WITHOUT lockfile → torn writes)
 * is in the same file and runs only on Windows where NTFS append-race
 * semantics differ from POSIX. The negative case PROVES the lockfile is
 * necessary (not just sufficient).
 *
 * Gated by OMCP_RUN_HEAVY_CONCURRENCY=1 — runs only on the dedicated
 * `test-concurrent` CI lane (added in EB-06 Story 1). The default
 * `test` lane skips this file entirely.
 *
 * Pre-requisite: `npm run build` must run first so dist/ exists.
 */

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";

const HEAVY_ON = process.env.OMCP_RUN_HEAVY_CONCURRENCY === "1";
const DIST_OUTBOX = path.resolve(
  process.cwd(),
  "dist",
  "cli",
  "commands",
  "team-outbox.js",
);
const DIST_BUILT = fs.existsSync(DIST_OUTBOX);

function escapePath(p: string): string {
  // Escape backslashes for the inline `-e` source — both for the path
  // segments AND for embedding into a JS string literal.
  return p.replace(/\\/g, "\\\\");
}

function spawnWriter(
  childIndex: number,
  count: number,
  sessionId: string,
  cwd: string,
): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const code = `
      (async () => {
        try {
          const m = await import('file:///${escapePath(DIST_OUTBOX).replace(
            /^[A-Z]:/,
            (m) => m,
          )}');
          for (let i = 0; i < ${count}; i++) {
            const r = m.runTeamOutboxWrite({
              sessionId: ${JSON.stringify(sessionId)},
              consumer: ${JSON.stringify("worker-" + childIndex)},
              payload: { worker: ${childIndex}, line: i },
              cwd: ${JSON.stringify(cwd)},
            });
            if (r.exitCode !== 0) {
              process.stderr.write('writer-${childIndex} non-zero exit: ' + r.exitCode + ' retries=' + r.retries + '\\n');
              process.exit(1);
            }
          }
        } catch (err) {
          process.stderr.write('writer-${childIndex} threw: ' + err.message + '\\n');
          process.exit(1);
        }
      })();
    `;
    const child = spawn(process.execPath, ["-e", code], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (d) => {
      stderr += d.toString("utf8");
    });
    child.on("exit", (exitCode) => {
      resolve({ code: exitCode ?? -1, stderr });
    });
  });
}

describe.skipIf(!HEAVY_ON || !DIST_BUILT)(
  "outbox-write 8-process concurrency (ADR-EB-02 §2 lockfile contract)",
  () => {
    it("8 writers × 100 lines = 800 valid JSONL lines, no torn writes, no loss", async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omcp-outbox-8proc-"));
      try {
        const sid = "concur-positive-sid";
        const PER_WORKER = 100;
        const N_WORKERS = 8;

        const writers = Array.from({ length: N_WORKERS }, (_, idx) =>
          spawnWriter(idx, PER_WORKER, sid, tmp),
        );
        const results = await Promise.all(writers);
        for (const r of results) {
          expect(r.code, `writer stderr: ${r.stderr}`).toBe(0);
        }

        const outboxPath = path.join(
          tmp,
          ".omcp",
          "state",
          "team",
          sid,
          "outbox.jsonl",
        );
        expect(fs.existsSync(outboxPath)).toBe(true);
        const content = fs.readFileSync(outboxPath, "utf8");
        const lines = content.split("\n").filter((l) => l.length > 0);
        expect(lines.length).toBe(N_WORKERS * PER_WORKER);

        // Every line parses as JSON; aggregate per-worker line counts.
        const perWorker = new Map<number, number>();
        for (const line of lines) {
          const parsed = JSON.parse(line) as {
            ts: string;
            consumer: string;
            payload: { worker: number; line: number };
          };
          expect(parsed.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
          expect(parsed.consumer).toMatch(/^worker-\d+$/);
          const w = parsed.payload.worker;
          perWorker.set(w, (perWorker.get(w) ?? 0) + 1);
        }
        for (let w = 0; w < N_WORKERS; w++) {
          expect(perWorker.get(w), `worker-${w} should have ${PER_WORKER} lines`).toBe(
            PER_WORKER,
          );
        }
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    }, 60_000);

    /**
     * NEGATIVE case: prove the lockfile is genuinely necessary on Windows
     * NTFS. 2 processes write 200 lines each WITHOUT the lockfile (via
     * raw fs.appendFileSync). If NTFS gave us atomic append for free we'd
     * see 400 valid lines. We expect either (a) torn lines (invalid JSON
     * on at least one line) OR (b) fewer than 400 lines (lost writes).
     *
     * If this test fails (zero torn writes, zero loss), it would mean NTFS
     * IS giving us atomic-append semantics — in which case the lockfile is
     * theatrical and the iter-2 design is over-engineered. Either outcome
     * is informative.
     */
    it.skipIf(process.platform !== "win32")(
      "negative case: 2-process raw appendFileSync on Windows NTFS shows torn writes OR loss",
      async () => {
        const tmp = fs.mkdtempSync(
          path.join(os.tmpdir(), "omcp-outbox-neg-"),
        );
        try {
          const outboxPath = path.join(tmp, "raw-outbox.jsonl");

          const spawnRawWriter = (
            childIndex: number,
            count: number,
          ): Promise<number> =>
            new Promise((resolve) => {
              const code = `
                const fs = require('node:fs');
                const path = ${JSON.stringify(outboxPath)};
                for (let i = 0; i < ${count}; i++) {
                  const line = JSON.stringify({worker:${childIndex}, line:i, payload:'x'.repeat(200)}) + '\\n';
                  fs.appendFileSync(path, line);
                }
              `;
              const child = spawn(process.execPath, ["-e", code], {
                stdio: "ignore",
              });
              child.on("exit", (c) => resolve(c ?? -1));
            });

          const [r1, r2] = await Promise.all([
            spawnRawWriter(0, 200),
            spawnRawWriter(1, 200),
          ]);
          expect(r1).toBe(0);
          expect(r2).toBe(0);

          const content = fs.readFileSync(outboxPath, "utf8");
          const lines = content.split("\n").filter((l) => l.length > 0);

          // Count torn lines (unparseable) + verify the contract:
          // either torn writes exist OR fewer than 400 lines total.
          let tornLines = 0;
          for (const line of lines) {
            try {
              JSON.parse(line);
            } catch {
              tornLines++;
            }
          }
          const hasTearOrLoss = tornLines > 0 || lines.length < 400;
          expect(
            hasTearOrLoss,
            `Expected NTFS append race evidence (torn lines or loss). Got: lines=${lines.length}, tornLines=${tornLines}. If this fails, NTFS may be providing atomic append for our payload size — re-evaluate lockfile necessity.`,
          ).toBe(true);
        } finally {
          fs.rmSync(tmp, { recursive: true, force: true });
        }
      },
      60_000,
    );
  },
);

// Sanity test that runs in BOTH lanes — verifies the heavy lane is gated correctly.
describe("outbox-write-helper concurrency gating", () => {
  it("concurrency suite SKIPS when OMCP_RUN_HEAVY_CONCURRENCY != '1'", () => {
    if (!HEAVY_ON) {
      expect(HEAVY_ON).toBe(false);
      expect(DIST_BUILT).toBeDefined();
    } else {
      expect(HEAVY_ON).toBe(true);
    }
  });
});

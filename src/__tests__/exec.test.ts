import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execHistoryPath, runExec } from "../cli/commands/exec.js";

describe("runExec", () => {
  let tmp: string;
  let cwdSnapshot: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "omcp-exec-"));
    cwdSnapshot = process.cwd();
    process.chdir(tmp);
  });

  afterEach(() => {
    process.chdir(cwdSnapshot);
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("builds the expected copilot args for a plain prompt", () => {
    const calls: { bin: string; args: string[] }[] = [];
    const r = runExec({
      prompt: "hello world",
      spawn: (bin, args) => {
        calls.push({ bin, args });
        return { status: 0 };
      },
    });
    expect(r.exitCode).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].bin).toBe("copilot");
    expect(calls[0].args.slice(0, 2)).toEqual(["-p", "hello world"]);
    expect(calls[0].args).toContain("--allow-all-tools");
  });

  it("passes --model, --agent, --silent, --share when set", () => {
    let captured: string[] = [];
    runExec({
      prompt: "p",
      model: "claude-sonnet-4.6",
      agent: "executor",
      silent: true,
      share: true,
      spawn: (_bin, args) => {
        captured = args;
        return { status: 0 };
      },
    });
    expect(captured).toContain("--model");
    expect(captured).toContain("claude-sonnet-4.6");
    expect(captured).toContain("--agent");
    expect(captured).toContain("executor");
    expect(captured).toContain("-s");
    expect(captured).toContain("--share");
  });

  it("omits --allow-all-tools when allowAllTools=false", () => {
    let captured: string[] = [];
    runExec({
      prompt: "p",
      allowAllTools: false,
      spawn: (_bin, args) => {
        captured = args;
        return { status: 0 };
      },
    });
    expect(captured).not.toContain("--allow-all-tools");
  });

  it("uses --resume=<id> when --inject is set", () => {
    let captured: string[] = [];
    runExec({
      prompt: "ping",
      inject: "sess-123",
      spawn: (_bin, args) => {
        captured = args;
        return { status: 0 };
      },
    });
    expect(captured).toContain("--resume=sess-123");
  });

  it("appends a JSONL row to .omcp/state/exec-history.jsonl", () => {
    runExec({
      prompt: "first",
      model: "gpt-5.2",
      spawn: () => ({ status: 0 }),
    });
    runExec({
      prompt: "second",
      inject: "sid-7",
      spawn: () => ({ status: 0 }),
    });

    const histPath = execHistoryPath(tmp);
    expect(existsSync(histPath)).toBe(true);
    const lines = readFileSync(histPath, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0].prompt).toBe("first");
    expect(lines[0].model).toBe("gpt-5.2");
    expect(lines[0].exitCode).toBe(0);
    expect(typeof lines[0].t).toBe("string");
    expect(typeof lines[0].durationMs).toBe("number");
    expect(lines[1].prompt).toBe("second");
    expect(lines[1].sessionId).toBe("sid-7");
  });

  it("records non-zero exit code", () => {
    runExec({
      prompt: "boom",
      spawn: () => ({ status: 42 }),
    });
    const histPath = execHistoryPath(tmp);
    const row = JSON.parse(readFileSync(histPath, "utf8").trim());
    expect(row.exitCode).toBe(42);
  });

  it("returns exitCode=2 and refuses empty prompt", () => {
    const calls: number[] = [];
    const r = runExec({
      prompt: "",
      spawn: () => {
        calls.push(1);
        return { status: 0 };
      },
    });
    expect(r.exitCode).toBe(2);
    expect(calls).toHaveLength(0);
  });
});

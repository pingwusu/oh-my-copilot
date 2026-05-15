import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadHooks, fireHooks } from "../hooks/runtime.js";

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), "omcp-hooks-runtime-"));
}

function pluginHooksDir(root: string): string {
  const d = join(root, "hooks");
  mkdirSync(d, { recursive: true });
  return d;
}

describe("hooks runtime", () => {
  let root: string;
  let dir: string;

  beforeEach(() => {
    root = makeRoot();
    dir = pluginHooksDir(root);
  });

  it("discovers a TS/JS hook module and dispatches it", async () => {
    // Write an ESM module that exports a default Hook object.
    const file = join(dir, "PreToolUse-noop.mjs");
    writeFileSync(
      file,
      [
        "export default {",
        '  name: "noop-test",',
        '  events: ["PreToolUse"],',
        '  async run(ctx) { return { kind: "advise", text: "hi " + ctx.sessionId }; }',
        "};",
      ].join("\n"),
      "utf8",
    );

    const entries = await fireHooks(
      "PreToolUse",
      { sessionId: "s1", cwd: process.cwd() },
      { pluginHooksDir: dir, repoHooksDir: join(root, "missing") },
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].hook).toBe("noop-test");
    expect(entries[0].result).toEqual({ kind: "advise", text: "hi s1" });
  });

  it("only dispatches hooks subscribed to the event", async () => {
    const file = join(dir, "PostToolUse-only.mjs");
    writeFileSync(
      file,
      [
        "export default {",
        '  name: "post-only",',
        '  events: ["PostToolUse"],',
        '  async run() { return { kind: "noop" }; }',
        "};",
      ].join("\n"),
      "utf8",
    );

    const pre = await fireHooks(
      "PreToolUse",
      { sessionId: "s1", cwd: process.cwd() },
      { pluginHooksDir: dir, repoHooksDir: join(root, "missing") },
    );
    expect(pre).toHaveLength(0);

    const post = await fireHooks(
      "PostToolUse",
      { sessionId: "s1", cwd: process.cwd() },
      { pluginHooksDir: dir, repoHooksDir: join(root, "missing") },
    );
    expect(post).toHaveLength(1);
  });

  it("dispatches multiple hooks in registration order (filename-sorted)", async () => {
    writeFileSync(
      join(dir, "01-PreToolUse-a.mjs"),
      [
        "export default {",
        '  name: "a",',
        '  events: ["PreToolUse"],',
        '  async run() { return { kind: "advise", text: "a" }; }',
        "};",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      join(dir, "02-PreToolUse-b.mjs"),
      [
        "export default {",
        '  name: "b",',
        '  events: ["PreToolUse"],',
        '  async run() { return { kind: "advise", text: "b" }; }',
        "};",
      ].join("\n"),
      "utf8",
    );

    const entries = await fireHooks(
      "PreToolUse",
      { sessionId: "s1", cwd: process.cwd() },
      { pluginHooksDir: dir, repoHooksDir: join(root, "missing") },
    );
    expect(entries.map((e) => e.hook)).toEqual(["a", "b"]);
  });

  it("times out a slow TS hook and returns noop", async () => {
    writeFileSync(
      join(dir, "PreToolUse-slow.mjs"),
      [
        "export default {",
        '  name: "slow",',
        '  events: ["PreToolUse"],',
        '  async run() { await new Promise((r) => setTimeout(r, 500)); return { kind: "advise", text: "late" }; }',
        "};",
      ].join("\n"),
      "utf8",
    );

    const entries = await fireHooks(
      "PreToolUse",
      { sessionId: "s1", cwd: process.cwd() },
      {
        pluginHooksDir: dir,
        repoHooksDir: join(root, "missing"),
        timeoutMs: 50,
      },
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].result).toEqual({ kind: "noop" });
  });

  it("loadHooks returns an empty registry when no dirs exist", async () => {
    const empty = mkdtempSync(join(tmpdir(), "omcp-hooks-empty-"));
    const reg = await loadHooks({
      pluginHooksDir: join(empty, "missing-1"),
      repoHooksDir: join(empty, "missing-2"),
    });
    expect(reg.hooks).toEqual([]);
  });

  // POSIX-only: spawn /bin/sh is unavailable on Windows runners.
  const itPosix = process.platform === "win32" ? it.skip : it;
  itPosix(
    "discovers a POSIX shell hook and parses its stdout JSON",
    async () => {
      const file = join(dir, "PreToolUse-shell.sh");
      writeFileSync(
        file,
        [
          "#!/bin/sh",
          "read -r payload",
          "# echo a HookResult JSON",
          'printf \'{"kind":"advise","text":"from-sh"}\\n\'',
        ].join("\n"),
        "utf8",
      );
      chmodSync(file, 0o755);

      const entries = await fireHooks(
        "PreToolUse",
        { sessionId: "s1", cwd: process.cwd() },
        { pluginHooksDir: dir, repoHooksDir: join(root, "missing") },
      );
      expect(entries).toHaveLength(1);
      expect(entries[0].result).toEqual({ kind: "advise", text: "from-sh" });
    },
  );

  itPosix("times out a slow shell hook and returns noop", async () => {
    const file = join(dir, "PreToolUse-sleep.sh");
    writeFileSync(
      file,
      ["#!/bin/sh", "sleep 5", 'printf \'{"kind":"advise","text":"late"}\\n\''].join(
        "\n",
      ),
      "utf8",
    );
    chmodSync(file, 0o755);

    const entries = await fireHooks(
      "PreToolUse",
      { sessionId: "s1", cwd: process.cwd() },
      {
        pluginHooksDir: dir,
        repoHooksDir: join(root, "missing"),
        timeoutMs: 100,
      },
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].result).toEqual({ kind: "noop" });
  });
});

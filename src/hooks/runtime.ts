// Hooks runtime — discover hooks from the user's installed plugin directory and
// repo-local `.omcp/hooks/`, then dispatch them for a given HookContext.
//
// Discovery roots (in order):
//   1. ${OMCP_PLUGIN_ROOT}/hooks/ if env set, else
//      ~/.copilot/installed-plugins/oh-my-copilot/oh-my-copilot/hooks/
//   2. ${cwd}/.omcp/hooks/
//
// Supported hook formats:
//   - TS/JS module exporting a default Hook (or named export `hook`)
//   - Shell script (*.sh) — invoked via /bin/sh with HookContext piped as JSON on
//     stdin, expected to print a HookResult JSON to stdout. POSIX-only.
//   - PowerShell script (*.ps1) — invoked via pwsh with the same protocol.
//
// Each hook gets HOOK_TIMEOUT_MS (default 5000ms). On timeout: returns
// {kind:"noop"} and logs to stderr.

import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  Hook,
  HookContext,
  HookEvent,
  HookRegistry,
  HookResult,
} from "./hook-types.js";
import { createRegistry } from "./hook-types.js";

export const HOOK_TIMEOUT_MS = 5000;

export interface LoadOptions {
  /** Override the user-plugin hooks root. Defaults to OMCP_PLUGIN_ROOT or ~/.copilot/... */
  pluginHooksDir?: string;
  /** Override repo-local hooks root (defaults to ${cwd}/.omcp/hooks). */
  repoHooksDir?: string;
  /** Working directory used for resolving repoHooksDir. */
  cwd?: string;
  /** Override env (for tests). */
  env?: NodeJS.ProcessEnv;
  /** Per-hook timeout override (ms). */
  timeoutMs?: number;
}

function defaultPluginHooksDir(env: NodeJS.ProcessEnv): string {
  const root =
    env.OMCP_PLUGIN_ROOT ??
    join(
      homedir(),
      ".copilot",
      "installed-plugins",
      "oh-my-copilot",
      "oh-my-copilot",
    );
  return join(root, "hooks");
}

function defaultRepoHooksDir(cwd: string): string {
  return join(cwd, ".omcp", "hooks");
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function listHookFiles(dir: string): string[] {
  if (!existsSync(dir) || !isDir(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".")) continue;
    const full = join(dir, name);
    try {
      if (!statSync(full).isFile()) continue;
    } catch {
      continue;
    }
    if (/\.(ts|js|mjs|cjs|sh|ps1)$/i.test(name)) out.push(full);
  }
  // Sort for stable registration order.
  return out.sort();
}

function isHookLike(value: unknown): value is Hook {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.name === "string" &&
    Array.isArray(v.events) &&
    typeof v.run === "function"
  );
}

async function loadTsHook(file: string): Promise<Hook | null> {
  const url = pathToFileURL(isAbsolute(file) ? file : resolvePath(file)).href;
  const mod = (await import(url)) as Record<string, unknown>;
  const candidates: unknown[] = [mod.default, mod.hook, mod];
  for (const c of candidates) {
    if (isHookLike(c)) return c;
  }
  return null;
}

function inferEventsFromFilename(file: string): HookEvent[] {
  const lower = file.toLowerCase();
  const all: HookEvent[] = [
    "PreToolUse",
    "PostToolUse",
    "PreSubmit",
    "PostSubmit",
    "SessionStart",
    "PreEnd",
  ];
  return all.filter((e) => lower.includes(e.toLowerCase()));
}

function makeShellHook(file: string, timeoutMs: number): Hook {
  const isPwsh = file.toLowerCase().endsWith(".ps1");
  const events = inferEventsFromFilename(file);
  // If no event inferred, register for all events — let the script decide.
  const subscribedEvents: HookEvent[] =
    events.length > 0
      ? events
      : [
          "PreToolUse",
          "PostToolUse",
          "PreSubmit",
          "PostSubmit",
          "SessionStart",
          "PreEnd",
        ];
  const name = file.split(/[\\/]/).pop() ?? file;
  return {
    name,
    events: subscribedEvents,
    run(ctx: HookContext): Promise<HookResult> {
      return runShellHook(file, ctx, { isPwsh, timeoutMs });
    },
  };
}

function runShellHook(
  file: string,
  ctx: HookContext,
  opts: { isPwsh: boolean; timeoutMs: number },
): Promise<HookResult> {
  return new Promise((resolveResult) => {
    const cmd = opts.isPwsh ? "pwsh" : "/bin/sh";
    const args = opts.isPwsh
      ? ["-NoProfile", "-NonInteractive", "-File", file]
      : [file];
    let stdout = "";
    let stderr = "";
    let settled = false;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      process.stderr.write(
        `omcp hook: spawn failed for ${file}: ${(err as Error).message}\n`,
      );
      resolveResult({ kind: "noop" });
      return;
    }

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      process.stderr.write(
        `omcp hook: timeout after ${opts.timeoutMs}ms — ${file}\n`,
      );
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      resolveResult({ kind: "noop" });
    }, opts.timeoutMs);

    child.stdout?.on("data", (b) => {
      stdout += b.toString();
    });
    child.stderr?.on("data", (b) => {
      stderr += b.toString();
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stderr.write(`omcp hook: ${file} error: ${err.message}\n`);
      resolveResult({ kind: "noop" });
    });
    child.on("close", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (stderr.trim()) {
        process.stderr.write(`omcp hook(${file}): ${stderr}`);
      }
      const trimmed = stdout.trim();
      if (!trimmed) {
        resolveResult({ kind: "noop" });
        return;
      }
      try {
        const parsed = JSON.parse(trimmed) as HookResult;
        if (
          parsed &&
          typeof parsed === "object" &&
          typeof (parsed as { kind?: unknown }).kind === "string"
        ) {
          resolveResult(parsed);
          return;
        }
      } catch {
        // fall through
      }
      process.stderr.write(
        `omcp hook: ${file} did not emit valid HookResult JSON\n`,
      );
      resolveResult({ kind: "noop" });
    });

    try {
      child.stdin?.end(`${JSON.stringify(ctx)}\n`);
    } catch (err) {
      process.stderr.write(
        `omcp hook: ${file} stdin write failed: ${(err as Error).message}\n`,
      );
    }
  });
}

function wrapWithTimeout(hook: Hook, timeoutMs: number): Hook {
  return {
    name: hook.name,
    events: hook.events,
    run(ctx: HookContext): Promise<HookResult> {
      return new Promise((res) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          process.stderr.write(
            `omcp hook: timeout after ${timeoutMs}ms — ${hook.name}\n`,
          );
          res({ kind: "noop" });
        }, timeoutMs);
        hook
          .run(ctx)
          .then((r) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            res(r);
          })
          .catch((err: unknown) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            process.stderr.write(
              `omcp hook: ${hook.name} threw: ${(err as Error).message}\n`,
            );
            res({ kind: "noop" });
          });
      });
    },
  };
}

export async function loadHooks(opts: LoadOptions = {}): Promise<HookRegistry> {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const timeoutMs = opts.timeoutMs ?? HOOK_TIMEOUT_MS;

  const dirs = [
    opts.pluginHooksDir ?? defaultPluginHooksDir(env),
    opts.repoHooksDir ?? defaultRepoHooksDir(cwd),
  ];

  const registry = createRegistry();
  for (const dir of dirs) {
    const files = listHookFiles(dir);
    for (const file of files) {
      const ext = file.split(".").pop()?.toLowerCase() ?? "";
      try {
        if (ext === "sh" || ext === "ps1") {
          if (ext === "sh" && process.platform === "win32") {
            // Skip POSIX shell hooks on Windows.
            continue;
          }
          if (ext === "ps1" && process.platform !== "win32") {
            // Skip pwsh hooks on non-Windows unless pwsh is on PATH; we keep it
            // simple and only attempt on win32.
            continue;
          }
          registry.register(makeShellHook(file, timeoutMs));
        } else {
          const hook = await loadTsHook(file);
          if (hook) registry.register(wrapWithTimeout(hook, timeoutMs));
        }
      } catch (err) {
        process.stderr.write(
          `omcp hook: failed to load ${file}: ${(err as Error).message}\n`,
        );
      }
    }
  }
  return registry;
}

export interface FireResultEntry {
  hook: string;
  result: HookResult;
}

export async function fireHooks(
  event: HookEvent,
  ctx: Omit<HookContext, "event">,
  opts: LoadOptions = {},
): Promise<FireResultEntry[]> {
  const registry = await loadHooks(opts);
  const full: HookContext = { ...ctx, event };
  const entries: FireResultEntry[] = [];
  for (const h of registry.hooks) {
    if (!h.events.includes(event)) continue;
    const result = await h.run(full);
    entries.push({ hook: h.name, result });
  }
  return entries;
}

/** Read a JSON HookContext payload from stdin (empty stdin -> defaults). */
export function readStdinJson(): Promise<Partial<HookContext>> {
  return new Promise((resolveResult) => {
    if (process.stdin.isTTY) {
      resolveResult({});
      return;
    }
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      buf += chunk;
    });
    process.stdin.on("end", () => {
      const trimmed = buf.trim();
      if (!trimmed) {
        resolveResult({});
        return;
      }
      try {
        resolveResult(JSON.parse(trimmed) as Partial<HookContext>);
      } catch {
        resolveResult({});
      }
    });
    process.stdin.on("error", () => resolveResult({}));
  });
}

export interface RunFireCliOpts {
  event: string;
  json?: boolean;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  loadOptions?: LoadOptions;
}

const VALID_EVENTS: HookEvent[] = [
  "PreToolUse",
  "PostToolUse",
  "PreSubmit",
  "PostSubmit",
  "SessionStart",
  "PreEnd",
];

export async function runFireCli(opts: RunFireCliOpts): Promise<number> {
  if (!VALID_EVENTS.includes(opts.event as HookEvent)) {
    process.stderr.write(`omcp hook fire: unknown event "${opts.event}"\n`);
    return 2;
  }
  const event = opts.event as HookEvent;
  const stdinPayload = await readStdinJson();
  const cwd = opts.cwd ?? process.cwd();
  const ctx: Omit<HookContext, "event"> = {
    sessionId:
      typeof stdinPayload.sessionId === "string" ? stdinPayload.sessionId : "",
    cwd: typeof stdinPayload.cwd === "string" ? stdinPayload.cwd : cwd,
    toolName:
      typeof stdinPayload.toolName === "string" ? stdinPayload.toolName : undefined,
    toolArgs: stdinPayload.toolArgs,
    toolResult: stdinPayload.toolResult,
  };
  const entries = await fireHooks(event, ctx, opts.loadOptions ?? { env: opts.env, cwd });
  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ event, results: entries })}\n`);
  } else {
    for (const e of entries) {
      const r = e.result;
      if (r.kind === "advise") {
        process.stdout.write(`[${e.hook}] advise: ${r.text}\n`);
      } else if (r.kind === "block") {
        process.stdout.write(`[${e.hook}] block: ${r.reason}\n`);
      }
    }
  }
  return 0;
}

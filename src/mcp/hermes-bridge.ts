// omcp Hermes coordination bridge — manages child Copilot sessions.
//
// Each session is one spawned `copilot -p "<prompt>" --allow-all-tools` process
// (or test stub via OMCP_HERMES_CHILD_CMD). State lives under
// .omcp/state/hermes/<sessionId>/ with session.json, output.log, and
// artifacts/ subtree.
//
// tmux-first when available (mirrors team.ts), detached-process fallback.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";

export type HermesMode = "tmux" | "detached";

export interface HermesSessionMeta {
  sessionId: string;
  prompt: string;
  agent?: string;
  model?: string;
  pid?: number;
  tmuxSession?: string;
  mode: HermesMode;
  status: "running" | "done" | "idle" | "killed";
  startedAt: string;
  endedAt?: string;
  exitCode?: number;
  command: string;
  args: string[];
  cwd: string;
  logPath: string;
  artifactDir: string;
}

const HERMES_ROOT_ENV = "OMCP_HERMES_ROOT";
const CHILD_CMD_ENV = "OMCP_HERMES_CHILD_CMD";
const CHILD_ARGS_ENV = "OMCP_HERMES_CHILD_ARGS";

function hermesRoot(): string {
  return (
    process.env[HERMES_ROOT_ENV] ??
    join(process.cwd(), ".omcp", "state", "hermes")
  );
}

function sessionDir(sessionId: string): string {
  return join(hermesRoot(), sessionId);
}

function metaPath(sessionId: string): string {
  return join(sessionDir(sessionId), "session.json");
}

function logPathFor(sessionId: string): string {
  return join(sessionDir(sessionId), "output.log");
}

function artifactDirFor(sessionId: string): string {
  return join(sessionDir(sessionId), "artifacts");
}

function validateSessionId(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new Error(
      `sessionId must match /^[A-Za-z0-9_-]{1,128}$/ (got: ${value})`,
    );
  }
  return value;
}

function readMeta(sessionId: string): HermesSessionMeta | null {
  const p = metaPath(sessionId);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as HermesSessionMeta;
  } catch {
    return null;
  }
}

function writeMeta(meta: HermesSessionMeta): void {
  mkdirSync(sessionDir(meta.sessionId), { recursive: true });
  writeFileSync(metaPath(meta.sessionId), JSON.stringify(meta, null, 2));
}

export function tmuxAvailable(): boolean {
  if (process.env.OMCP_HERMES_FORCE_DETACHED === "1") return false;
  const r = spawnSync(
    process.platform === "win32" ? "where" : "which",
    ["tmux"],
    { encoding: "utf8" },
  );
  return r.status === 0 && r.stdout.trim().length > 0;
}

function resolveChildCommand(): { command: string; baseArgs: string[] } {
  const cmd = process.env[CHILD_CMD_ENV];
  if (cmd) {
    const raw = process.env[CHILD_ARGS_ENV];
    let baseArgs: string[] = [];
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) baseArgs = parsed.map(String);
      } catch {
        baseArgs = raw.split(/\s+/).filter(Boolean);
      }
    }
    return { command: cmd, baseArgs };
  }
  return { command: "copilot", baseArgs: ["--allow-all-tools"] };
}

function pidAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function tmuxSessionAlive(name: string | undefined): boolean {
  if (!name) return false;
  const r = spawnSync("tmux", ["has-session", "-t", name], {
    encoding: "utf8",
  });
  return r.status === 0;
}

function refreshStatus(meta: HermesSessionMeta): HermesSessionMeta {
  if (meta.status !== "running") return meta;
  const alive =
    meta.mode === "tmux"
      ? tmuxSessionAlive(meta.tmuxSession)
      : pidAlive(meta.pid);
  if (!alive) {
    meta.status = "done";
    meta.endedAt = meta.endedAt ?? new Date().toISOString();
    writeMeta(meta);
  }
  return meta;
}

export interface StartSessionInput {
  prompt: string;
  sessionId?: string;
  agent?: string;
  model?: string;
}

export function startSession(input: StartSessionInput): HermesSessionMeta {
  if (typeof input.prompt !== "string" || !input.prompt.trim()) {
    throw new Error("prompt is required and must be a non-empty string");
  }
  const sessionId = validateSessionId(input.sessionId ?? randomUUID());
  if (readMeta(sessionId)) {
    throw new Error(`sessionId already exists: ${sessionId}`);
  }
  mkdirSync(sessionDir(sessionId), { recursive: true });
  mkdirSync(artifactDirFor(sessionId), { recursive: true });

  const { command, baseArgs } = resolveChildCommand();
  const args = [...baseArgs, "-p", input.prompt];
  if (input.agent) args.push("--agent", input.agent);
  if (input.model) args.push("--model", input.model);

  const log = logPathFor(sessionId);
  const cwd = process.cwd();
  const useTmux = tmuxAvailable();
  const startedAt = new Date().toISOString();

  if (useTmux) {
    const tmuxSession = `omcp-hermes-${sessionId.slice(0, 8)}`;
    const shellCmd = `${[command, ...args]
      .map((a) => JSON.stringify(a))
      .join(" ")} 2>&1 | tee ${JSON.stringify(log)}`;
    const r = spawnSync(
      "tmux",
      ["new-session", "-d", "-s", tmuxSession, shellCmd],
      { stdio: "pipe", encoding: "utf8" },
    );
    if (r.status !== 0) {
      throw new Error(
        `tmux new-session failed: ${r.stderr?.trim() ?? r.status}`,
      );
    }
    const meta: HermesSessionMeta = {
      sessionId,
      prompt: input.prompt,
      agent: input.agent,
      model: input.model,
      tmuxSession,
      mode: "tmux",
      status: "running",
      startedAt,
      command,
      args,
      cwd,
      logPath: log,
      artifactDir: artifactDirFor(sessionId),
    };
    writeMeta(meta);
    return meta;
  }

  // Detached fallback — pipe stdout+stderr to log file.
  mkdirSync(sessionDir(sessionId), { recursive: true });
  // Touch the log so list/tail work even before child writes.
  writeFileSync(log, "");
  // Open the log for the child stdio.
  const fd = openSync(log, "a");
  const child = spawn(command, args, {
    cwd,
    detached: true,
    stdio: ["ignore", fd, fd],
    env: { ...process.env, OMCP_HERMES_MCP_BRIDGE: "1" },
  }) as ChildProcess;
  child.unref();
  closeSync(fd);

  if (!child.pid) {
    throw new Error("child process did not report a pid");
  }

  const meta: HermesSessionMeta = {
    sessionId,
    prompt: input.prompt,
    agent: input.agent,
    model: input.model,
    pid: child.pid,
    mode: "detached",
    status: "running",
    startedAt,
    command,
    args,
    cwd,
    logPath: log,
    artifactDir: artifactDirFor(sessionId),
  };
  writeMeta(meta);
  return meta;
}

export interface SendPromptInput {
  sessionId: string;
  prompt: string;
}

export function sendPrompt(input: SendPromptInput): {
  sessionId: string;
  delivered: boolean;
  via: "tmux" | "queue";
  queuedAt: string;
} {
  const sessionId = validateSessionId(input.sessionId);
  const meta = readMeta(sessionId);
  if (!meta) throw new Error(`unknown sessionId: ${sessionId}`);
  const prompt = String(input.prompt ?? "");
  if (!prompt.trim()) throw new Error("prompt must be non-empty");

  refreshStatus(meta);
  const now = new Date().toISOString();

  if (meta.mode === "tmux" && meta.tmuxSession && tmuxSessionAlive(meta.tmuxSession)) {
    // Pipe new turn via tmux send-keys.
    spawnSync("tmux", [
      "send-keys",
      "-t",
      meta.tmuxSession,
      prompt,
      "Enter",
    ]);
    return { sessionId, delivered: true, via: "tmux", queuedAt: now };
  }

  // Detached mode: append to a follow-up queue file (consumer would be a
  // watcher; here we just persist the request so it's auditable).
  const queuePath = join(sessionDir(sessionId), "followup-queue.jsonl");
  const entry = JSON.stringify({ at: now, prompt }) + "\n";
  appendFileSync(queuePath, entry);
  return { sessionId, delivered: false, via: "queue", queuedAt: now };
}

export function readStatus(sessionId: string): {
  sessionId: string;
  status: HermesSessionMeta["status"];
  mode: HermesMode;
  pid?: number;
  tmuxSession?: string;
  startedAt: string;
  endedAt?: string;
} {
  validateSessionId(sessionId);
  const meta = readMeta(sessionId);
  if (!meta) throw new Error(`unknown sessionId: ${sessionId}`);
  refreshStatus(meta);
  return {
    sessionId: meta.sessionId,
    status: meta.status,
    mode: meta.mode,
    pid: meta.pid,
    tmuxSession: meta.tmuxSession,
    startedAt: meta.startedAt,
    endedAt: meta.endedAt,
  };
}

export function readTail(
  sessionId: string,
  lines: number = 80,
): { sessionId: string; lines: string[]; path: string } {
  validateSessionId(sessionId);
  const meta = readMeta(sessionId);
  if (!meta) throw new Error(`unknown sessionId: ${sessionId}`);
  const safeLines = Math.max(1, Math.min(Math.floor(lines || 80), 5000));
  if (!existsSync(meta.logPath)) {
    return { sessionId, lines: [], path: meta.logPath };
  }
  const content = readFileSync(meta.logPath, "utf8");
  const all = content.split(/\r?\n/);
  // Drop trailing empty if the file ends with \n.
  const trimmed =
    all.length > 0 && all[all.length - 1] === "" ? all.slice(0, -1) : all;
  return {
    sessionId,
    lines: trimmed.slice(-safeLines),
    path: meta.logPath,
  };
}

export function listArtifacts(sessionId: string): {
  sessionId: string;
  artifacts: Array<{ path: string; bytes: number; modifiedAt: string }>;
  root: string;
} {
  validateSessionId(sessionId);
  const meta = readMeta(sessionId);
  if (!meta) throw new Error(`unknown sessionId: ${sessionId}`);
  const root = meta.artifactDir;
  if (!existsSync(root)) {
    return { sessionId, artifacts: [], root };
  }
  const out: Array<{ path: string; bytes: number; modifiedAt: string }> = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        const info = statSync(full);
        out.push({
          path: relative(root, full).split("\\").join("/"),
          bytes: info.size,
          modifiedAt: info.mtime.toISOString(),
        });
      }
    }
  };
  walk(root);
  out.sort((a, b) => a.path.localeCompare(b.path));
  return { sessionId, artifacts: out, root };
}

export function killSession(sessionId: string): {
  sessionId: string;
  killed: boolean;
  mode: HermesMode;
  reason?: string;
} {
  validateSessionId(sessionId);
  const meta = readMeta(sessionId);
  if (!meta) throw new Error(`unknown sessionId: ${sessionId}`);
  refreshStatus(meta);
  if (meta.status !== "running") {
    return { sessionId, killed: false, mode: meta.mode, reason: "not running" };
  }

  if (meta.mode === "tmux" && meta.tmuxSession) {
    spawnSync("tmux", ["kill-session", "-t", meta.tmuxSession]);
  } else if (meta.pid) {
    try {
      process.kill(meta.pid, "SIGTERM");
    } catch (err) {
      return {
        sessionId,
        killed: false,
        mode: meta.mode,
        reason: (err as Error).message,
      };
    }
  }
  meta.status = "killed";
  meta.endedAt = new Date().toISOString();
  writeMeta(meta);
  return { sessionId, killed: true, mode: meta.mode };
}

export function listSessions(): { sessions: HermesSessionMeta[] } {
  const root = hermesRoot();
  if (!existsSync(root)) return { sessions: [] };
  const out: HermesSessionMeta[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const meta = readMeta(entry.name);
    if (meta) {
      refreshStatus(meta);
      out.push(meta);
    }
  }
  out.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  return { sessions: out };
}

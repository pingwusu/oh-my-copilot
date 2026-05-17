// `omcp cleanup` — sweep orphaned omcp artifacts off the system.
//
// Targets:
//   1. Orphan MCP processes whose parent (copilot/omcp) is gone.
//      Detection strategy: scan PID files under .omcp/state/mcp/*.pid (the
//      conventional location omcp MCP launchers write to). A pid is "orphan"
//      when the parent pid recorded alongside it (parent_pid in a sibling
//      .json or in the pid file's "pid:parent" form) is dead while the child
//      is alive. We additionally treat a pid file as stale (and remove it)
//      when its own pid is dead.
//   2. Stale tmp dirs under `os.tmpdir()/omcp-*` older than max-age-days.
//   3. Stale session dirs under `.omcp/state/sessions/<id>/` older than
//      max-age-days (measured by mtime).
//   4. Loop-watcher pid file if the recorded pid is dead.
//
// --dry-run        report intended actions without touching disk / processes
// --max-age-days N override the default 30-day window

import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface CleanupOptions {
  dryRun?: boolean;
  maxAgeDays?: number;
  cwd?: string;
  tmpRoot?: string;
  /** Test hook — override pid liveness probe (defaults to process.kill(pid,0)). */
  isAlive?: (pid: number) => boolean;
  /** Test hook — override process killer (defaults to process.kill(pid,'SIGTERM')). */
  killProcess?: (pid: number) => void;
  /** Test hook — override "now" for mtime comparisons. */
  now?: () => number;
}

export interface CleanupPlanItem {
  kind:
    | "orphan-mcp"
    | "stale-mcp-pidfile"
    | "tmp-dir"
    | "session-dir"
    | "loop-watcher-pidfile";
  path: string;
  detail?: string;
}

export interface CleanupReport {
  dryRun: boolean;
  maxAgeDays: number;
  items: CleanupPlanItem[];
  killed: number[];
  removed: string[];
  errors: string[];
}

const DEFAULT_MAX_AGE_DAYS = 30;

export function runCleanup(opts: CleanupOptions = {}): CleanupReport {
  const cwd = opts.cwd ?? process.cwd();
  const tmpRoot = opts.tmpRoot ?? tmpdir();
  const maxAgeDays = opts.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS;
  const dryRun = Boolean(opts.dryRun);
  const now = opts.now ? opts.now() : Date.now();
  const cutoff = now - maxAgeDays * 24 * 60 * 60 * 1000;
  const isAlive = opts.isAlive ?? defaultIsAlive;
  const killProcess = opts.killProcess ?? defaultKill;

  const items: CleanupPlanItem[] = [];
  const killed: number[] = [];
  const removed: string[] = [];
  const errors: string[] = [];

  // 1. Orphan / stale MCP pid files.
  const mcpDir = join(cwd, ".omcp", "state", "mcp");
  if (existsSync(mcpDir)) {
    for (const f of safeReaddir(mcpDir)) {
      if (!f.endsWith(".pid")) continue;
      const pidPath = join(mcpDir, f);
      const parsed = readPidFile(pidPath);
      if (!parsed) {
        items.push({
          kind: "stale-mcp-pidfile",
          path: pidPath,
          detail: "unreadable",
        });
        if (!dryRun) tryUnlink(pidPath, removed, errors);
        continue;
      }
      const { pid, parentPid } = parsed;
      const childAlive = isAlive(pid);
      const parentAlive = parentPid !== undefined && isAlive(parentPid);
      if (!childAlive) {
        items.push({
          kind: "stale-mcp-pidfile",
          path: pidPath,
          detail: `pid ${pid} not alive`,
        });
        if (!dryRun) tryUnlink(pidPath, removed, errors);
      } else if (parentPid !== undefined && !parentAlive) {
        items.push({
          kind: "orphan-mcp",
          path: pidPath,
          detail: `pid ${pid} alive, parent ${parentPid} dead`,
        });
        if (!dryRun) {
          try {
            killProcess(pid);
            killed.push(pid);
          } catch (err) {
            errors.push(`kill ${pid}: ${(err as Error).message}`);
          }
          tryUnlink(pidPath, removed, errors);
        }
      }
    }
  }

  // 2. Stale tmp dirs (os.tmpdir()/omcp-*).
  for (const name of safeReaddir(tmpRoot)) {
    if (!name.startsWith("omcp-")) continue;
    const full = join(tmpRoot, name);
    const st = safeStat(full);
    if (!st || !st.isDirectory()) continue;
    if (st.mtimeMs >= cutoff) continue;
    items.push({
      kind: "tmp-dir",
      path: full,
      detail: `mtime ${new Date(Number(st.mtimeMs)).toISOString()}`,
    });
    if (!dryRun) tryRmRecursive(full, removed, errors);
  }

  // 3. Stale session dirs under .omcp/state/sessions/.
  const sessionsDir = join(cwd, ".omcp", "state", "sessions");
  if (existsSync(sessionsDir)) {
    for (const id of safeReaddir(sessionsDir)) {
      const full = join(sessionsDir, id);
      const st = safeStat(full);
      if (!st || !st.isDirectory()) continue;
      if (st.mtimeMs >= cutoff) continue;
      items.push({
        kind: "session-dir",
        path: full,
        detail: `mtime ${new Date(Number(st.mtimeMs)).toISOString()}`,
      });
      if (!dryRun) tryRmRecursive(full, removed, errors);
    }
  }

  // 4. Loop-watcher pid file.
  const loopPidPath = join(cwd, ".omcp", "state", "loop-watcher.pid");
  if (existsSync(loopPidPath)) {
    const parsed = readPidFile(loopPidPath);
    if (!parsed || !isAlive(parsed.pid)) {
      items.push({
        kind: "loop-watcher-pidfile",
        path: loopPidPath,
        detail: parsed ? `pid ${parsed.pid} not alive` : "unreadable",
      });
      if (!dryRun) tryUnlink(loopPidPath, removed, errors);
    }
  }

  return { dryRun, maxAgeDays, items, killed, removed, errors };
}

function readPidFile(
  path: string,
): { pid: number; parentPid?: number } | undefined {
  try {
    const raw = readFileSync(path, "utf8").trim();
    if (!raw) return undefined;
    // Accept either bare "<pid>" or "<pid>:<parentPid>" or JSON {pid,parentPid}.
    if (raw.startsWith("{")) {
      const j = JSON.parse(raw) as { pid?: number; parentPid?: number };
      if (typeof j.pid !== "number" || !Number.isFinite(j.pid)) return undefined;
      return { pid: j.pid, parentPid: j.parentPid };
    }
    const [pidStr, parentStr] = raw.split(":");
    const pid = Number(pidStr);
    if (!Number.isFinite(pid)) return undefined;
    const parentPid = parentStr !== undefined ? Number(parentStr) : undefined;
    return {
      pid,
      parentPid: parentPid !== undefined && Number.isFinite(parentPid) ? parentPid : undefined,
    };
  } catch {
    return undefined;
  }
}

function defaultIsAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function defaultKill(pid: number): void {
  process.kill(pid, "SIGTERM");
}

function safeReaddir(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function safeStat(path: string): ReturnType<typeof statSync> | undefined {
  try {
    return statSync(path);
  } catch {
    return undefined;
  }
}

function tryUnlink(path: string, removed: string[], errors: string[]): void {
  try {
    unlinkSync(path);
    removed.push(path);
  } catch (err) {
    errors.push(`unlink ${path}: ${(err as Error).message}`);
  }
}

function tryRmRecursive(path: string, removed: string[], errors: string[]): void {
  try {
    rmSync(path, { recursive: true, force: true });
    removed.push(path);
  } catch (err) {
    errors.push(`rm ${path}: ${(err as Error).message}`);
  }
}

export function formatCleanupReport(r: CleanupReport): string {
  const head = `omcp cleanup ${r.dryRun ? "(dry-run) " : ""}— ${r.items.length} item(s), max-age-days=${r.maxAgeDays}`;
  if (r.items.length === 0) return `${head}\n  nothing to clean`;
  const rows = r.items.map((i) => `  [${i.kind}] ${i.path}${i.detail ? `  (${i.detail})` : ""}`);
  if (r.killed.length > 0) rows.push(`  killed pids: ${r.killed.join(", ")}`);
  if (r.errors.length > 0) {
    rows.push("  errors:");
    for (const e of r.errors) rows.push(`    ${e}`);
  }
  return [head, ...rows].join("\n");
}

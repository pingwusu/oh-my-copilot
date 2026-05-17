// `omcp loop-watcher` — start/stop/status for the loop watcher daemon.

import { execSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

function pidFile(): string {
  return join(process.cwd(), ".omcp", "state", "loop-watcher.pid");
}

function logFile(): string {
  return join(process.cwd(), ".omcp", "state", "loop-watcher.log");
}

export function startWatcher(scriptPath: string): { pid: number } {
  mkdirSync(join(process.cwd(), ".omcp", "state"), { recursive: true });
  if (isRunning()) {
    const pid = readPid();
    throw new Error(`omcp loop-watcher: already running (pid=${pid})`);
  }
  const out = require("node:fs").openSync(logFile(), "a");
  const err = require("node:fs").openSync(logFile(), "a");
  const child = spawn(process.execPath, [scriptPath, "--quiet"], {
    detached: true,
    stdio: ["ignore", out, err],
  });
  child.unref();
  if (!child.pid) throw new Error("omcp loop-watcher: spawn failed (no pid)");
  writeFileSync(pidFile(), String(child.pid));
  return { pid: child.pid };
}

export function stopWatcher(): { stopped: boolean; pid?: number } {
  if (!existsSync(pidFile())) return { stopped: false };
  const pid = readPid();
  try {
    if (process.platform === "win32") {
      execSync(`taskkill /PID ${pid} /F`, { stdio: "ignore" });
    } else {
      process.kill(pid, "SIGTERM");
    }
  } catch {
    // already dead
  }
  unlinkSync(pidFile());
  return { stopped: true, pid };
}

export function statusWatcher(): {
  running: boolean;
  pid?: number;
  pidFile: string;
  logFile: string;
} {
  const f = pidFile();
  const lf = logFile();
  if (!existsSync(f)) return { running: false, pidFile: f, logFile: lf };
  const pid = readPid();
  return { running: isPidAlive(pid), pid, pidFile: f, logFile: lf };
}

function readPid(): number {
  return Number(readFileSync(pidFile(), "utf8").trim());
}

function isRunning(): boolean {
  if (!existsSync(pidFile())) return false;
  return isPidAlive(readPid());
}

function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

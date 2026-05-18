// `omcp loop-watcher` — start/stop/status for the loop watcher daemon.

import { execSync, spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
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

  // Atomic exclusive create: openSync with "wx" fails with EEXIST if the
  // pidfile already exists, eliminating the TOCTOU window between a
  // liveness check and the write.
  let fd: number;
  try {
    fd = openSync(pidFile(), "wx");
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") {
      const existingPid = readPid();
      if (isPidAlive(existingPid)) {
        throw new Error(`omcp loop-watcher: already running (pid=${existingPid})`);
      }
      // Stale pidfile — remove and retry once.
      unlinkSync(pidFile());
      fd = openSync(pidFile(), "wx");
    } else {
      throw e;
    }
  }

  // We hold an exclusive fd on the pidfile. Spawn the child, write the pid, close.
  const logFd = openSync(logFile(), "a");
  const child = spawn(process.execPath, [scriptPath, "--quiet"], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
  if (!child.pid) {
    closeSync(fd);
    unlinkSync(pidFile());
    throw new Error("omcp loop-watcher: spawn failed (no pid)");
  }
  writeSync(fd, Buffer.from(String(child.pid)));
  closeSync(fd);
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

function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

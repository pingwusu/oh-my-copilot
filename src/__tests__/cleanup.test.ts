import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCleanup } from "../cli/commands/cleanup.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function backdate(path: string, days: number): void {
  const t = (Date.now() - days * MS_PER_DAY) / 1000;
  utimesSync(path, t, t);
}

describe("runCleanup", () => {
  let cwd: string;
  let fakeTmp: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "omcp-cleanup-cwd-"));
    fakeTmp = mkdtempSync(join(tmpdir(), "omcp-cleanup-tmp-"));
  });

  afterEach(() => {
    for (const p of [cwd, fakeTmp]) {
      try {
        rmSync(p, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  function makeStaleSession(id: string, days: number): string {
    const dir = join(cwd, ".omcp", "state", "sessions", id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "worker-1.log"), "stale");
    backdate(dir, days);
    return dir;
  }

  function makeStaleTmp(name: string, days: number): string {
    const dir = join(fakeTmp, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "junk"), "x");
    backdate(dir, days);
    return dir;
  }

  it("dry-run reports stale dirs without removing them", () => {
    const oldSession = makeStaleSession("old", 60);
    const newSession = makeStaleSession("new", 0);
    const oldTmp = makeStaleTmp("omcp-old", 60);
    const unrelatedTmp = makeStaleTmp("other-tool-old", 60);

    const report = runCleanup({
      dryRun: true,
      cwd,
      tmpRoot: fakeTmp,
      isAlive: () => false,
    });

    expect(report.dryRun).toBe(true);
    const paths = report.items.map((i) => i.path);
    expect(paths).toContain(oldSession);
    expect(paths).toContain(oldTmp);
    expect(paths).not.toContain(newSession);
    expect(paths).not.toContain(unrelatedTmp);

    // Nothing actually removed.
    expect(existsSync(oldSession)).toBe(true);
    expect(existsSync(oldTmp)).toBe(true);
  });

  it("removes stale session dirs and tmp dirs in real run", () => {
    const oldSession = makeStaleSession("old", 60);
    const recentSession = makeStaleSession("recent", 5);
    const oldTmp = makeStaleTmp("omcp-old", 60);
    const recentTmp = makeStaleTmp("omcp-recent", 5);

    const report = runCleanup({
      cwd,
      tmpRoot: fakeTmp,
      isAlive: () => false,
    });

    expect(report.removed).toContain(oldSession);
    expect(report.removed).toContain(oldTmp);
    expect(existsSync(oldSession)).toBe(false);
    expect(existsSync(oldTmp)).toBe(false);
    expect(existsSync(recentSession)).toBe(true);
    expect(existsSync(recentTmp)).toBe(true);
  });

  it("honors --max-age-days override", () => {
    makeStaleSession("ten-days", 10);
    const r5 = runCleanup({
      dryRun: true,
      cwd,
      tmpRoot: fakeTmp,
      maxAgeDays: 5,
      isAlive: () => false,
    });
    expect(r5.items.some((i) => i.kind === "session-dir")).toBe(true);

    const r30 = runCleanup({
      dryRun: true,
      cwd,
      tmpRoot: fakeTmp,
      maxAgeDays: 30,
      isAlive: () => false,
    });
    expect(r30.items.some((i) => i.kind === "session-dir")).toBe(false);
  });

  it("removes loop-watcher.pid when pid is dead", () => {
    const pidPath = join(cwd, ".omcp", "state", "loop-watcher.pid");
    mkdirSync(join(cwd, ".omcp", "state"), { recursive: true });
    writeFileSync(pidPath, "999999");

    const report = runCleanup({
      cwd,
      tmpRoot: fakeTmp,
      isAlive: () => false,
    });
    expect(report.items.some((i) => i.kind === "loop-watcher-pidfile")).toBe(true);
    expect(existsSync(pidPath)).toBe(false);
  });

  it("leaves loop-watcher.pid alone when pid is alive", () => {
    const pidPath = join(cwd, ".omcp", "state", "loop-watcher.pid");
    mkdirSync(join(cwd, ".omcp", "state"), { recursive: true });
    writeFileSync(pidPath, "12345");

    const report = runCleanup({
      cwd,
      tmpRoot: fakeTmp,
      isAlive: () => true,
    });
    expect(report.items.some((i) => i.kind === "loop-watcher-pidfile")).toBe(false);
    expect(existsSync(pidPath)).toBe(true);
  });

  it("identifies orphan MCP procs (child alive, parent dead) and kills them", () => {
    const mcpDir = join(cwd, ".omcp", "state", "mcp");
    mkdirSync(mcpDir, { recursive: true });
    const orphanPid = join(mcpDir, "state.pid");
    writeFileSync(orphanPid, "1001:2002"); // child:parent
    const stalePid = join(mcpDir, "stale.pid");
    writeFileSync(stalePid, "3003"); // bare pid, dead

    const killed: number[] = [];
    const report = runCleanup({
      cwd,
      tmpRoot: fakeTmp,
      isAlive: (pid) => pid === 1001, // child alive, parent and stale dead
      killProcess: (pid) => {
        killed.push(pid);
      },
    });

    expect(report.items.some((i) => i.kind === "orphan-mcp")).toBe(true);
    expect(report.items.some((i) => i.kind === "stale-mcp-pidfile")).toBe(true);
    expect(killed).toContain(1001);
    expect(existsSync(orphanPid)).toBe(false);
    expect(existsSync(stalePid)).toBe(false);
  });

  it("returns empty plan when nothing is stale", () => {
    const report = runCleanup({
      cwd,
      tmpRoot: fakeTmp,
      isAlive: () => true,
    });
    expect(report.items).toHaveLength(0);
    expect(report.removed).toHaveLength(0);
  });
});

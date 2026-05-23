import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  writeShardState,
  readShardState,
  listShardWorkers,
  mergeShards,
  getShardFilePath,
  getMergeReportPath,
  getShardsDir,
} from "../../../lib/team-shard-state.js";
import { runTeamMergeShards } from "../team.js";
import { writePrd, writeRalphState, readPrd } from "../../../lib/ralph-state.js";
import type { PRD, RalphState } from "../../../lib/ralph-state.js";
import type { ShardStory } from "../../../lib/team-shard-state.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "omcp-shard-test-"));
}

function makePrd(stories: Array<{ id: string; passes?: boolean }>): PRD {
  return {
    project: "test-project",
    branchName: "test-branch",
    description: "Test PRD",
    userStories: stories.map((s, i) => ({
      id: s.id,
      title: `Story ${s.id}`,
      description: `Description for ${s.id}`,
      acceptanceCriteria: ["criterion 1"],
      priority: i + 1,
      passes: s.passes ?? false,
    })),
  };
}

function seedPrd(cwd: string, stories: Array<{ id: string; passes?: boolean }>): void {
  // Write a minimal ralph state so readPrd finds the default prd.json path
  const state: RalphState = {
    active: true,
    iteration: 1,
    lastFiredAt: new Date().toISOString(),
    prompt: "test task",
  };
  writeRalphState(state, cwd);
  writePrd(makePrd(stories), cwd);
}

// ─── writeShardState / readShardState ─────────────────────────────────────────

describe("writeShardState / readShardState", () => {
  let cwd: string;

  beforeEach(() => { cwd = tempDir(); });
  afterEach(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

  it("writes a shard and reads it back", () => {
    const stories: ShardStory[] = [{ id: "US-001", passes: true, notes: "done" }];
    const ok = writeShardState("worker1", stories, cwd);
    expect(ok).toBe(true);

    const shard = readShardState("worker1", cwd);
    expect(shard).not.toBeNull();
    expect(shard!.workerName).toBe("worker1");
    expect(shard!.stories).toHaveLength(1);
    expect(shard!.stories[0].passes).toBe(true);
  });

  it("returns null for missing shard", () => {
    expect(readShardState("nobody", cwd)).toBeNull();
  });

  it("rejects unsafe worker name", () => {
    expect(() => writeShardState("../escape", [], cwd)).toThrow("unsafe");
  });

  it("creates shards dir atomically (file is valid JSON)", () => {
    writeShardState("workerA", [{ id: "US-002", passes: false }], cwd);
    const shardFile = getShardFilePath("workerA", cwd);
    expect(fs.existsSync(shardFile)).toBe(true);
    expect(() => JSON.parse(fs.readFileSync(shardFile, "utf-8"))).not.toThrow();
  });
});

// ─── listShardWorkers ─────────────────────────────────────────────────────────

describe("listShardWorkers", () => {
  let cwd: string;

  beforeEach(() => { cwd = tempDir(); });
  afterEach(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

  it("returns empty array when no shards dir exists", () => {
    expect(listShardWorkers(cwd)).toEqual([]);
  });

  it("lists workers sorted alphabetically", () => {
    writeShardState("workerC", [], cwd);
    writeShardState("workerA", [], cwd);
    writeShardState("workerB", [], cwd);
    expect(listShardWorkers(cwd)).toEqual(["workerA", "workerB", "workerC"]);
  });
});

// ─── 4-worker concurrent shard write ─────────────────────────────────────────

describe("4-worker concurrent shard write", () => {
  let cwd: string;

  beforeEach(() => { cwd = tempDir(); });
  afterEach(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

  it("all 4 workers write independent shards without collision", () => {
    const workers = ["worker1", "worker2", "worker3", "worker4"];
    for (const w of workers) {
      const ok = writeShardState(w, [{ id: `US-00${w.slice(-1)}`, passes: true }], cwd);
      expect(ok).toBe(true);
    }
    expect(listShardWorkers(cwd)).toHaveLength(4);
    for (const w of workers) {
      const shard = readShardState(w, cwd);
      expect(shard).not.toBeNull();
      expect(shard!.workerName).toBe(w);
    }
  });

  it("shards dir contains exactly 4 shard files after 4 workers write", () => {
    const workers = ["alpha", "beta", "gamma", "delta"];
    for (const w of workers) {
      writeShardState(w, [{ id: "US-001", passes: true }], cwd);
    }
    const dir = getShardsDir(cwd);
    const files = fs.readdirSync(dir).filter((f) => f.endsWith("-prd-shard.json"));
    expect(files).toHaveLength(4);
  });
});

// ─── merge — no conflicts ──────────────────────────────────────────────────────

describe("mergeShards — no conflicts", () => {
  let cwd: string;

  beforeEach(() => { cwd = tempDir(); });
  afterEach(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

  it("merges two shards covering different stories without conflicts", () => {
    seedPrd(cwd, [
      { id: "US-001", passes: false },
      { id: "US-002", passes: false },
    ]);
    writeShardState("worker1", [{ id: "US-001", passes: true }], cwd);
    writeShardState("worker2", [{ id: "US-002", passes: true }], cwd);

    const report = mergeShards("my-team", cwd);
    expect(report.conflicts).toHaveLength(0);
    expect(report.storiesUpdated).toBe(2);
    expect(report.shardsProcessed).toBe(2);
  });

  it("leaves stories not mentioned in any shard unchanged", () => {
    seedPrd(cwd, [
      { id: "US-001", passes: false },
      { id: "US-002", passes: false },
    ]);
    writeShardState("worker1", [{ id: "US-001", passes: true }], cwd);

    const report = mergeShards("my-team", cwd);
    expect(report.storiesUpdated).toBe(1);
    expect(report.conflicts).toHaveLength(0);
  });
});

// ─── merge — with conflicts ────────────────────────────────────────────────────

describe("mergeShards — with conflicts", () => {
  let cwd: string;

  beforeEach(() => { cwd = tempDir(); });
  afterEach(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

  it("records conflict when one worker passes and another fails same story", () => {
    seedPrd(cwd, [{ id: "US-001", passes: false }]);
    writeShardState("worker1", [{ id: "US-001", passes: true }], cwd);
    writeShardState("worker2", [{ id: "US-001", passes: false }], cwd);

    const report = mergeShards("conflict-team", cwd);
    expect(report.conflicts).toHaveLength(1);
    expect(report.conflicts[0].storyId).toBe("US-001");
    expect(report.conflicts[0].winnerPasses).toBe(true);
  });

  it("optimistic merge: passes=true wins over passes=false", () => {
    seedPrd(cwd, [{ id: "US-001", passes: false }]);
    writeShardState("workerA", [{ id: "US-001", passes: false }], cwd);
    writeShardState("workerB", [{ id: "US-001", passes: true }], cwd);

    const report = mergeShards("opt-team", cwd);
    // workerB wins because it set passes=true
    expect(report.conflicts[0].winnerPasses).toBe(true);

    // Verify the canonical PRD was updated
    const prd = readPrd(cwd);
    expect(prd!.userStories[0].passes).toBe(true);
  });

  it("multiple workers all passing same story — records conflict, first alpha wins", () => {
    seedPrd(cwd, [{ id: "US-001", passes: false }]);
    writeShardState("workerA", [{ id: "US-001", passes: true, notes: "A done" }], cwd);
    writeShardState("workerB", [{ id: "US-001", passes: true, notes: "B done" }], cwd);

    const report = mergeShards("multi-team", cwd);
    expect(report.conflicts).toHaveLength(1);
    expect(report.conflicts[0].winner).toBe("workerA");
    expect(report.conflicts[0].losers).toContain("workerB");
  });
});

// ─── merge report contents ────────────────────────────────────────────────────

describe("merge report", () => {
  let cwd: string;

  beforeEach(() => { cwd = tempDir(); });
  afterEach(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

  it("writes merge-report.json to shards dir", () => {
    seedPrd(cwd, [{ id: "US-001", passes: false }]);
    writeShardState("w1", [{ id: "US-001", passes: true }], cwd);
    mergeShards("rep-team", cwd);

    const reportPath = getMergeReportPath(cwd);
    expect(fs.existsSync(reportPath)).toBe(true);
    const report = JSON.parse(fs.readFileSync(reportPath, "utf-8"));
    expect(report.teamName).toBe("rep-team");
    expect(report.shardsProcessed).toBe(1);
    expect(report.storiesUpdated).toBe(1);
  });

  it("report contains worker names", () => {
    seedPrd(cwd, [{ id: "US-001", passes: false }]);
    writeShardState("alpha", [{ id: "US-001", passes: true }], cwd);
    writeShardState("beta", [{ id: "US-001", passes: false }], cwd);
    mergeShards("workers-team", cwd);

    const report = JSON.parse(fs.readFileSync(getMergeReportPath(cwd), "utf-8"));
    expect(report.workers).toContain("alpha");
    expect(report.workers).toContain("beta");
  });

  it("returns report with storiesUpdated=0 and no error when no PRD exists", () => {
    writeShardState("w1", [{ id: "US-001", passes: true }], cwd);
    const report = mergeShards("no-prd-team", cwd);
    expect(report.storiesUpdated).toBe(0);
    expect(report.shardsProcessed).toBe(1);
    // merge-report.json is still written
    expect(fs.existsSync(getMergeReportPath(cwd))).toBe(true);
  });

  it("rejects unsafe teamName", () => {
    expect(() => mergeShards("../escape", cwd)).toThrow("unsafe");
  });
});

// ─── runTeamMergeShards (CLI wrapper) ─────────────────────────────────────────

describe("runTeamMergeShards", () => {
  let cwd: string;

  beforeEach(() => { cwd = tempDir(); });
  afterEach(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

  it("returns ok:true and report on success", () => {
    seedPrd(cwd, [{ id: "US-001", passes: false }]);
    writeShardState("w1", [{ id: "US-001", passes: true }], cwd);
    const result = runTeamMergeShards("my-team", { cwd });
    expect(result.ok).toBe(true);
    expect(result.report).toBeDefined();
    expect(result.report!.teamName).toBe("my-team");
  });

  it("returns ok:false with error message on unsafe team name", () => {
    const result = runTeamMergeShards("../escape", { cwd });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("unsafe");
  });
});

// ─── session isolation ────────────────────────────────────────────────────────

describe("session isolation", () => {
  let cwd1: string;
  let cwd2: string;

  beforeEach(() => {
    cwd1 = tempDir();
    cwd2 = tempDir();
  });
  afterEach(() => {
    fs.rmSync(cwd1, { recursive: true, force: true });
    fs.rmSync(cwd2, { recursive: true, force: true });
  });

  it("shards written to different worktrees are completely isolated", () => {
    writeShardState("worker1", [{ id: "US-001", passes: true }], cwd1);
    writeShardState("worker1", [{ id: "US-001", passes: false }], cwd2);

    const s1 = readShardState("worker1", cwd1);
    const s2 = readShardState("worker1", cwd2);
    expect(s1!.stories[0].passes).toBe(true);
    expect(s2!.stories[0].passes).toBe(false);
  });

  it("merge in one worktree does not affect the other", () => {
    seedPrd(cwd1, [{ id: "US-001", passes: false }]);
    seedPrd(cwd2, [{ id: "US-001", passes: false }]);
    writeShardState("w1", [{ id: "US-001", passes: true }], cwd1);

    mergeShards("team-A", cwd1);

    // cwd2's merge-report should not exist
    expect(fs.existsSync(getMergeReportPath(cwd2))).toBe(false);
  });
});

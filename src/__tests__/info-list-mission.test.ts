import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatInfo, readInfo } from "../cli/commands/info.js";
import {
  formatCatalog,
  listAgents,
  listSkills,
} from "../cli/commands/list.js";
import { formatBoard, loadMissions } from "../cli/commands/mission-board.js";

const ROOT = join(__dirname, "..", "..");

describe("info", () => {
  it("reports installation state + catalog counts", () => {
    const r = readInfo(ROOT);
    // Accept prerelease tags per semver spec (e.g., 2.0.0-rc.1)
    expect(r.version).toMatch(/^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?$/);
    expect(r.agentCount).toBeGreaterThanOrEqual(19);
    expect(r.skillCount).toBeGreaterThanOrEqual(30);
    expect(r.mcpServers.length).toBeGreaterThanOrEqual(4);
    const text = formatInfo(r);
    expect(text).toMatch(/omcp info/);
    expect(text).toMatch(/agents:\s+\d+/);
    expect(text).toMatch(/mcp servers:/);
  });
});

describe("list", () => {
  it("listAgents returns all ported agents", () => {
    const agents = listAgents(ROOT);
    expect(agents.length).toBeGreaterThanOrEqual(19);
    expect(agents.some((a) => a.name === "executor")).toBe(true);
    expect(agents.some((a) => a.name === "planner")).toBe(true);
  });

  it("listSkills returns all ported skills", () => {
    const skills = listSkills(ROOT);
    expect(skills.length).toBeGreaterThanOrEqual(30);
    expect(skills.some((s) => s.name === "ralph")).toBe(true);
    expect(skills.some((s) => s.name === "autopilot")).toBe(true);
  });

  it("formatCatalog produces 'no X found' for empty input", () => {
    expect(formatCatalog([], "agents")).toMatch(/no agents found/);
    expect(formatCatalog([], "skills")).toMatch(/no skills found/);
    expect(formatCatalog([], "all")).toMatch(/no all found/);
  });

  it("formatCatalog renders headers for agents/skills/all", () => {
    const agents = listAgents(ROOT).slice(0, 2);
    expect(formatCatalog(agents, "agents")).toMatch(/^Agents \(\d+\):/);
    const skills = listSkills(ROOT).slice(0, 2);
    expect(formatCatalog(skills, "skills")).toMatch(/^Skills \(\d+\):/);
    expect(formatCatalog([...agents, ...skills], "all")).toMatch(
      /^Catalog \(\d+ agents, \d+ skills\):/,
    );
  });
});

describe("mission-board", () => {
  let tmp: string;
  let cwdSnapshot: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "omcp-mb-"));
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

  it("returns empty when no .omcp/missions/", () => {
    expect(loadMissions()).toEqual([]);
    expect(formatBoard([])).toMatch(/no missions found/);
  });

  it("sorts by status then priority", () => {
    const dir = join(tmp, ".omcp", "missions");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "a.md"),
      "---\ntitle: low-prio done\nstatus: done\npriority: 1\n---\nbody",
    );
    writeFileSync(
      join(dir, "b.md"),
      "---\ntitle: high-prio active\nstatus: active\npriority: 1\n---\nbody",
    );
    writeFileSync(
      join(dir, "c.md"),
      "---\ntitle: low-prio active\nstatus: active\npriority: 5\n---\nbody",
    );
    writeFileSync(
      join(dir, "d.md"),
      "---\ntitle: blocked\nstatus: blocked\n---\nbody",
    );

    const ms = loadMissions();
    expect(ms.map((m) => m.slug)).toEqual(["b", "c", "d", "a"]);
    expect(formatBoard(ms)).toMatch(/mission-board \(4\):/);
  });

  it("status defaults to 'unknown' when frontmatter omits it", () => {
    const dir = join(tmp, ".omcp", "missions");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "x.md"), "---\ntitle: untyped\n---\nbody");
    const ms = loadMissions();
    expect(ms[0].status).toBe("unknown");
  });
});

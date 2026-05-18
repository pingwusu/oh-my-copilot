import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  doctorTeamRoutingCommand,
  runDoctorTeamRouting,
} from "../cli/commands/doctor-team-routing.js";

// We can't reliably know whether `copilot` / `tmux` exist on the test host,
// so the probes assert on shape, not on level for those binaries.

describe("runDoctorTeamRouting", () => {
  let tmp: string;
  let prevCwd: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "omcp-doctor-team-"));
    prevCwd = process.cwd();
    process.chdir(tmp);
  });

  afterEach(() => {
    process.chdir(prevCwd);
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns probes for copilot, tmux, mode state and team availability", () => {
    const report = runDoctorTeamRouting();
    const names = report.probes.map((p) => p.name);
    expect(names).toContain("copilot CLI");
    expect(names).toContain("tmux");
    expect(names).toContain("mode state");
    expect(names).toContain("team mode availability");
  });

  it("reports team startable on a clean workspace (no mode state)", () => {
    const report = runDoctorTeamRouting();
    expect(report.canStartTeam).toBe(true);
    expect(report.activeModes).toEqual([]);
    expect(
      report.probes.find((p) => p.name === "mode state")?.level,
    ).toBe("ok");
  });

  it("warns when a mutually-exclusive mode is active", () => {
    const stateDir = join(tmp, ".omcp", "state");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, "ralph-state.json"),
      JSON.stringify({
        active: true,
        session_id: "test",
        started_at: new Date().toISOString(),
        iteration: 1,
        max_iterations: 10,
      }),
    );
    const report = runDoctorTeamRouting();
    expect(report.activeModes).toContain("ralph");
    const modeProbe = report.probes.find((p) => p.name === "mode state");
    expect(modeProbe?.level).toBe("warn");
    expect(modeProbe?.detail).toContain("ralph");
    // team itself is non-mutually-exclusive, so canStartMode("team") is still ok.
    expect(
      report.probes.find((p) => p.name === "team mode availability")?.level,
    ).toBe("ok");
  });

  it("doctorTeamRoutingCommand returns 0 or 2 (fail only on missing copilot)", async () => {
    const code = await doctorTeamRoutingCommand({ json: true });
    expect([0, 2]).toContain(code);
  });

  it("doctorTeamRoutingCommand emits JSON when --json", async () => {
    const orig = process.stdout.write.bind(process.stdout);
    let captured = "";
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      captured += typeof chunk === "string" ? chunk : chunk.toString();
      return true;
    }) as typeof process.stdout.write;
    try {
      await doctorTeamRoutingCommand({ json: true });
    } finally {
      process.stdout.write = orig;
    }
    const parsed = JSON.parse(captured.trim()) as ReturnType<
      typeof runDoctorTeamRouting
    >;
    expect(parsed.probes).toBeInstanceOf(Array);
    expect(typeof parsed.canStartTeam).toBe("boolean");
  });
});

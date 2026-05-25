// release.ts — bump version, sync metadata across manifests, commit + tag.
// Usage:
//   npm run release -- 0.1.0           # explicit semver
//   npm run release -- patch|minor|major
//   npm run release -- --dry-run 0.1.0
//   npm run release -- 2.1.0 --bump-only             # manifests only; no commit/tag
//   npm run release -- 2.1.0 --allow-deterministic-only
//     # skip the live-smoke tag gate (use ONLY for hotfix releases where
//     # operator has explicitly accepted that no live-Copilot smoke ran)
//
// v2.1 Story 20: tag-cut is gated on `checkLiveSmoke()` from
// src/scripts/check-live-smoke.ts. When ZERO live-mode smoke artifacts
// are present under docs/smoke/omcp-team-parity/, the release exits 1
// with the canonical message: "v2.1.0 LOCAL tag blocked: ≥1 live-smoke
// required — capture P1, P3, or P4 with real Copilot CLI auth".
// Operators bypass the gate via --allow-deterministic-only (documented
// path for hotfixes that don't require fresh smoke).

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkLiveSmoke, formatLiveSmokeReport } from "./check-live-smoke.js";
import { sync as syncPluginMirror } from "./sync-plugin-mirror.js";

const ROOT = join(import.meta.dirname ?? __dirname, "..", "..");

interface SemVer {
  major: number;
  minor: number;
  patch: number;
}

function parseSemver(s: string): SemVer {
  // Accept prerelease tags per semver spec (e.g., 2.0.0-rc.1) — they are
  // parsed but the prerelease component is discarded for bump arithmetic.
  // Bumping from a prerelease drops the suffix (rc.1 patch -> next patch).
  const m = s.match(/^(\d+)\.(\d+)\.(\d+)(?:-[a-zA-Z0-9.]+)?$/);
  if (!m) throw new Error(`bad semver: ${s}`);
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

function fmtSemver(v: SemVer): string {
  return `${v.major}.${v.minor}.${v.patch}`;
}

function bump(current: SemVer, kind: "patch" | "minor" | "major"): SemVer {
  if (kind === "major") return { major: current.major + 1, minor: 0, patch: 0 };
  if (kind === "minor")
    return { major: current.major, minor: current.minor + 1, patch: 0 };
  return { major: current.major, minor: current.minor, patch: current.patch + 1 };
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function writeJsonPretty(path: string, data: unknown): void {
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
}

interface ReleaseResult {
  from: string;
  to: string;
  touched: string[];
  tag: string;
  dryRun: boolean;
  /** True iff `--bump-only` was passed (no commit, no tag). */
  bumpOnly: boolean;
  /**
   * True iff the live-smoke gate was bypassed via
   * `--allow-deterministic-only`. Recorded for downstream audit.
   */
  allowedDeterministicOnly: boolean;
}

/** Sentinel thrown when the live-smoke gate refuses to cut the tag. */
export class LiveSmokeTagBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LiveSmokeTagBlockedError";
  }
}

export function release(argv: string[]): ReleaseResult {
  const dryRun = argv.includes("--dry-run");
  const bumpOnly = argv.includes("--bump-only");
  const allowedDeterministicOnly = argv.includes(
    "--allow-deterministic-only",
  );
  const args = argv.filter(
    (a) =>
      a !== "--dry-run" &&
      a !== "--bump-only" &&
      a !== "--allow-deterministic-only",
  );
  const target = args[0];
  if (!target) {
    throw new Error(
      "usage: release <semver | patch | minor | major> [--dry-run] [--bump-only] [--allow-deterministic-only]",
    );
  }

  const pkgPath = join(ROOT, "package.json");
  const pkg = readJson<{ version: string; [k: string]: unknown }>(pkgPath);
  const from = parseSemver(pkg.version);

  let to: SemVer;
  if (target === "patch" || target === "minor" || target === "major") {
    to = bump(from, target);
  } else {
    to = parseSemver(target);
  }

  const touched: string[] = [];

  // package.json
  pkg.version = fmtSemver(to);
  if (!dryRun) writeJsonPretty(pkgPath, pkg);
  touched.push("package.json");

  // .claude-plugin/plugin.json
  const pmPath = join(ROOT, ".claude-plugin", "plugin.json");
  const plugin = readJson<{ version: string; [k: string]: unknown }>(pmPath);
  plugin.version = fmtSemver(to);
  if (!dryRun) writeJsonPretty(pmPath, plugin);
  touched.push(".claude-plugin/plugin.json");

  // .agents/plugins/marketplace.json
  const mpPath = join(ROOT, ".agents", "plugins", "marketplace.json");
  const mp = readJson<{ plugins: Array<{ version: string }> }>(mpPath);
  for (const p of mp.plugins ?? []) p.version = fmtSemver(to);
  if (!dryRun) writeJsonPretty(mpPath, mp);
  touched.push(".agents/plugins/marketplace.json");

  // CHANGELOG.md — replace the [Unreleased] header in-place only when the
  // body doesn't already carry a pre-existing [<to>] section (idempotent
  // when v2.1 Story 19 has already written the CHANGELOG entry).
  const clPath = join(ROOT, "CHANGELOG.md");
  const cl = readFileSync(clPath, "utf8");
  const today = new Date().toISOString().slice(0, 10);
  const alreadyEntered = new RegExp(
    `^## \\[${fmtSemver(to).replace(/\./g, "\\.")}\\]`,
    "m",
  ).test(cl);
  if (!alreadyEntered) {
    const nextCl = cl.replace(
      /^## \[Unreleased\]/m,
      `## [Unreleased]\n\n## [${fmtSemver(to)}] — ${today}`,
    );
    if (!dryRun) writeFileSync(clPath, nextCl);
    touched.push("CHANGELOG.md");
  }

  // 4th manifest — plugin mirror's .claude-plugin/plugin.json. The mirror
  // sync script copies it from the source .claude-plugin/ directory which
  // we just bumped, so syncing here keeps the cli-wiring-invariants
  // 4-manifest version check green. Invariant 3 (4-manifest sync).
  if (!dryRun) {
    syncPluginMirror();
  }
  touched.push("plugins/oh-my-copilot/.claude-plugin/plugin.json");

  // git commit + tag
  const tag = `v${fmtSemver(to)}`;

  // v2.1 Story 20 tag-gate: refuse to tag if zero live-smoke artifacts
  // are present (deterministic attestations alone do not satisfy the
  // iter-2 plan §RELEASE-cut S4 contract). The --bump-only and dry-run
  // paths short-circuit before this check so they can be exercised in
  // any state.
  if (!dryRun && !bumpOnly) {
    const smoke = checkLiveSmoke({ cwd: ROOT });
    // Surface the report to the operator before either proceeding to
    // commit/tag or aborting.
    // biome-ignore lint/suspicious/noConsole: release script
    console.log(formatLiveSmokeReport(smoke));
    if (!smoke.tagGateSatisfied && !allowedDeterministicOnly) {
      throw new LiveSmokeTagBlockedError(
        `${tag} LOCAL tag blocked: ≥1 live-smoke required — capture P1, P3, or P4 with real Copilot CLI auth (or re-run with --allow-deterministic-only to bypass for a hotfix)`,
      );
    }
  }

  if (!dryRun && !bumpOnly) {
    execSync(`git add ${touched.map((f) => JSON.stringify(f)).join(" ")}`, {
      cwd: ROOT,
      stdio: "inherit",
    });
    execSync(`git commit -m "chore(release): ${tag}"`, {
      cwd: ROOT,
      stdio: "inherit",
    });
    execSync(`git tag -a ${tag} -m "release ${tag}"`, {
      cwd: ROOT,
      stdio: "inherit",
    });
  }

  return {
    from: fmtSemver(from),
    to: fmtSemver(to),
    touched,
    tag,
    dryRun,
    bumpOnly,
    allowedDeterministicOnly,
  };
}

function main() {
  try {
    const result = release(process.argv.slice(2));
    console.log(
      `release ${result.dryRun ? "(dry-run) " : ""}${result.from} -> ${result.to}`,
    );
    for (const f of result.touched) console.log(`  + ${f}`);
    console.log(`  tag: ${result.tag}${result.dryRun ? " (not created)" : ""}`);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}

const isMain = process.argv[1] && process.argv[1].endsWith("release.js");
if (isMain) main();

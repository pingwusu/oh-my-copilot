import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { listSessions } from "../cli/commands/session.js";

// Phase E2 — `omcp session <query>` matched the query against worker logs
// via `new RegExp(query, "gi")` without escaping. Metachars in the query
// (e.g. `.`, `+`, `*`, `?`, `[`, `(`) silently turned a literal lookup
// into a regex match, producing surprise hits or ReDoS-prone patterns on
// adversarial input. Retrofit through escapeRegExp so the CLI behaves as
// a substring-grep by default.

describe("omcp session — escapeRegExp on user-supplied query (invariant 6)", () => {
  let savedCwd: string;
  let tmp: string;

  beforeEach(() => {
    savedCwd = process.cwd();
    tmp = mkdtempSync(join(tmpdir(), "omcp-session-"));
    const sessionsDir = join(tmp, ".omcp", "state", "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    // Create one session with a log containing literal text.
    const sid = join(sessionsDir, "smoke-001");
    mkdirSync(sid, { recursive: true });
    writeFileSync(
      join(sid, "worker-1.log"),
      "alpha bravo abc.def charlie a+b xRy\nabcXdef line two\nliteral regex hello\n",
    );
    process.chdir(tmp);
  });

  afterEach(() => {
    process.chdir(savedCwd);
    rmSync(tmp, { recursive: true, force: true });
  });

  it("metachar dot matches literal '.' only, not 'X' (escape applied)", () => {
    const results = listSessions("abc.def");
    expect(results).toHaveLength(1);
    // Pre-fix: `new RegExp("abc.def", "gi")` matched both `abc.def` AND
    // `abcXdef` because `.` is "any char". Post-fix only the literal hit
    // counts.
    expect(results[0]!.matches).toBe(1);
  });

  it("metachar plus matches literal '+' (no syntax error, no zero-or-more)", () => {
    // Pre-fix: `new RegExp("a+b", ...)` matched all `aaa...b` and `b` etc.
    // Post-fix: only matches the literal "a+b".
    const results = listSessions("a+b");
    expect(results).toHaveLength(1);
    expect(results[0]!.matches).toBe(1);
  });

  it("brackets in query do not throw and match literally", () => {
    // Without escaping, `[unclosed` would throw SyntaxError on the RegExp
    // constructor. With escape it's a literal lookup.
    const results = listSessions("[unclosed");
    expect(results).toHaveLength(1);
    // The fixture text doesn't contain the literal sequence "[unclosed",
    // so 0 matches expected, but importantly: NO THROW.
    expect(results[0]!.matches).toBe(0);
  });

  it("simple-substring queries still work", () => {
    const results = listSessions("alpha");
    expect(results).toHaveLength(1);
    expect(results[0]!.matches).toBe(1);
  });

  it("regex metachars in non-matching positions still match the literal", () => {
    // "literal regex" — no metachars; should match the literal phrase.
    const results = listSessions("literal regex");
    expect(results).toHaveLength(1);
    expect(results[0]!.matches).toBe(1);
  });

  it("case-insensitive still respected (the `gi` flag is preserved)", () => {
    const results = listSessions("LITERAL");
    expect(results).toHaveLength(1);
    expect(results[0]!.matches).toBe(1);
  });
});

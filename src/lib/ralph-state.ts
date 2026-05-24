// Ralph state — self-referential work-loop persistence for omcp.
//
// Ported from omc/src/hooks/ralph/{loop,prd,verifier,progress}.ts, but with
// the simpler state schema specified in HANDOFF.md:
//   { active, iteration, lastFiredAt, prompt, prdPath, architectApproved? }
//
// State file: .omcp/state/ralph-state.json (atomicWriteFileSync per
// invariant 2). PRD file: prdPath (state field) or .omcp/prd.json by
// fallback. Progress notes: .omcp/progress.txt (plain text, append-only).
//
// Surface exported per HANDOFF: readRalphState, writeRalphState,
// incrementRalphIteration, clearRalphState, getPrdCompletionStatus,
// getRalphContext, detectArchitectApproval, detectArchitectRejection.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { atomicWriteFileSync } from "../runtime/atomic-write.js";
import {
  ensureOmcpDir,
  getOmcpRoot,
  resolveStatePath,
} from "./worktree-paths.js";

// ──────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────

/** Ralph loop state — persisted at `.omcp/state/ralph-state.json`. */
export interface RalphState {
  /** Whether the loop is currently active. */
  active: boolean;
  /** Current iteration count (1-based). */
  iteration: number;
  /** ISO timestamp of the most recent fire (start or increment). */
  lastFiredAt: string;
  /** The original task prompt that started the loop. */
  prompt: string;
  /** Optional path to a PRD JSON file (absolute or relative to worktree). */
  prdPath?: string;
  /**
   * Set when the configured reviewer (architect / critic / codex) has signed
   * off on the completion claim. Persists across iterations to short-circuit
   * needless re-verification.
   */
  architectApproved?: boolean;
}

/** A single user story inside a PRD. */
export interface UserStory {
  /** Unique identifier (e.g. "US-001"). */
  id: string;
  /** Short, human-readable title. */
  title: string;
  /** Full user-story description. */
  description: string;
  /** List of acceptance criteria that must be met. */
  acceptanceCriteria: string[];
  /** Execution priority — lower number runs first. */
  priority: number;
  /** Whether this story is complete and verified. */
  passes: boolean;
  /** Optional notes recorded during implementation. */
  notes?: string;
}

/** PRD shape — mirrors omc's prd.json layout for cross-tool interoperability. */
export interface PRD {
  project: string;
  branchName: string;
  description: string;
  userStories: UserStory[];
}

/** Aggregated PRD status. */
export interface PRDStatus {
  total: number;
  completed: number;
  pending: number;
  allComplete: boolean;
  nextStory: UserStory | null;
  incompleteIds: string[];
}

// ──────────────────────────────────────────────────────────────────────────
// File paths
// ──────────────────────────────────────────────────────────────────────────

const STATE_NAME = "ralph";
const PROGRESS_FILENAME = "progress.txt";
const DEFAULT_PRD_FILENAME = "prd.json";

function statePath(worktreeRoot?: string): string {
  return resolveStatePath(STATE_NAME, worktreeRoot);
}

function progressPath(worktreeRoot?: string): string {
  return join(getOmcpRoot(worktreeRoot), PROGRESS_FILENAME);
}

function defaultPrdPath(worktreeRoot?: string): string {
  return join(getOmcpRoot(worktreeRoot), DEFAULT_PRD_FILENAME);
}

/**
 * Resolve a PRD path against the worktree root.
 *
 * Accepts absolute paths verbatim. Relative paths are resolved against the
 * worktree root rather than the cwd, so state remains stable when invoked
 * from a subdirectory.
 */
function resolvePrdPath(prdPath: string, worktreeRoot?: string): string {
  if (isAbsolute(prdPath)) return prdPath;
  const root = worktreeRoot ?? process.cwd();
  return resolve(root, prdPath);
}

// ──────────────────────────────────────────────────────────────────────────
// State CRUD
// ──────────────────────────────────────────────────────────────────────────

/** Read ralph state from disk, or `null` if no state file exists. */
export function readRalphState(worktreeRoot?: string): RalphState | null {
  const file = statePath(worktreeRoot);
  if (!existsSync(file)) return null;

  try {
    const raw = readFileSync(file, "utf-8");
    const parsed = JSON.parse(raw) as Partial<RalphState>;

    if (
      typeof parsed.active !== "boolean" ||
      typeof parsed.iteration !== "number" ||
      typeof parsed.lastFiredAt !== "string" ||
      typeof parsed.prompt !== "string"
    ) {
      return null;
    }

    const state: RalphState = {
      active: parsed.active,
      iteration: parsed.iteration,
      lastFiredAt: parsed.lastFiredAt,
      prompt: parsed.prompt,
    };
    if (typeof parsed.prdPath === "string") state.prdPath = parsed.prdPath;
    if (typeof parsed.architectApproved === "boolean") {
      state.architectApproved = parsed.architectApproved;
    }
    return state;
  } catch {
    return null;
  }
}

/**
 * Persist ralph state atomically.
 *
 * Creates `.omcp/state/` if absent. Returns true on success, false if the
 * write fails for any reason (caller decides whether to log).
 */
export function writeRalphState(
  state: RalphState,
  worktreeRoot?: string,
): boolean {
  const file = statePath(worktreeRoot);
  try {
    ensureOmcpDir("state", worktreeRoot);
    atomicWriteFileSync(file, JSON.stringify(state, null, 2));
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove the ralph state file if it exists.
 *
 * Returns true if the file was removed or absent. Returns false only if a
 * removal attempt failed unexpectedly.
 */
export function clearRalphState(worktreeRoot?: string): boolean {
  const file = statePath(worktreeRoot);
  if (!existsSync(file)) return true;
  try {
    unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Bump the iteration counter (and refresh lastFiredAt) on an active state.
 *
 * Returns the updated state on success. Returns null when no state exists,
 * when the loop is not active, or when the write fails.
 */
export function incrementRalphIteration(
  worktreeRoot?: string,
): RalphState | null {
  const state = readRalphState(worktreeRoot);
  if (!state || !state.active) return null;

  state.iteration += 1;
  state.lastFiredAt = new Date().toISOString();

  return writeRalphState(state, worktreeRoot) ? state : null;
}

// ──────────────────────────────────────────────────────────────────────────
// PRD reading
// ──────────────────────────────────────────────────────────────────────────

/**
 * Read the PRD referenced by ralph state, falling back to `.omcp/prd.json`.
 *
 * Returns null if no PRD file exists, the JSON is malformed, or the
 * userStories array is missing/invalid. The PRD file is treated as
 * optional — ralph operates without one in --no-prd legacy mode.
 */
export function readPrd(worktreeRoot?: string): PRD | null {
  const state = readRalphState(worktreeRoot);
  const candidate = state?.prdPath
    ? resolvePrdPath(state.prdPath, worktreeRoot)
    : defaultPrdPath(worktreeRoot);

  if (!existsSync(candidate)) return null;

  try {
    const prd = JSON.parse(readFileSync(candidate, "utf-8")) as PRD;
    if (!Array.isArray(prd.userStories)) return null;
    return prd;
  } catch {
    return null;
  }
}

/**
 * Write a PRD to the path referenced by ralph state (or the default
 * `.omcp/prd.json`). Creates the directory if needed. Returns true on success.
 */
export function writePrd(prd: PRD, worktreeRoot?: string): boolean {
  const state = readRalphState(worktreeRoot);
  const target = state?.prdPath
    ? resolvePrdPath(state.prdPath, worktreeRoot)
    : defaultPrdPath(worktreeRoot);
  try {
    ensureOmcpDir(".", worktreeRoot);
    const dir = dirname(target);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    atomicWriteFileSync(target, JSON.stringify(prd, null, 2));
    return true;
  } catch {
    return false;
  }
}

/** Compute aggregate PRD progress + identify the next story to work on. */
export function getPrdStatus(prd: PRD): PRDStatus {
  const stories = prd.userStories;
  const completed = stories.filter((s) => s.passes);
  const pending = stories.filter((s) => !s.passes);
  const sortedPending = [...pending].sort((a, b) => a.priority - b.priority);

  return {
    total: stories.length,
    completed: completed.length,
    pending: pending.length,
    allComplete: pending.length === 0,
    nextStory: sortedPending[0] ?? null,
    incompleteIds: pending.map((s) => s.id),
  };
}

/**
 * Return ralph's completion view of the PRD: whether one exists, whether
 * all stories pass, the next story to work, and the raw status struct.
 */
export function getPrdCompletionStatus(worktreeRoot?: string): {
  hasPrd: boolean;
  allComplete: boolean;
  status: PRDStatus | null;
  nextStory: UserStory | null;
} {
  const prd = readPrd(worktreeRoot);
  if (!prd) {
    return { hasPrd: false, allComplete: false, status: null, nextStory: null };
  }
  const status = getPrdStatus(prd);
  return {
    hasPrd: true,
    allComplete: status.allComplete,
    status,
    nextStory: status.nextStory,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Progress notes
// ──────────────────────────────────────────────────────────────────────────

/**
 * Read the worktree progress notes (`.omcp/progress.txt`), or `""` when
 * absent. Used to feed prior learnings into the next ralph iteration.
 */
export function readProgressNotes(worktreeRoot?: string): string {
  const file = progressPath(worktreeRoot);
  if (!existsSync(file)) return "";
  try {
    return readFileSync(file, "utf-8");
  } catch {
    return "";
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Progress-file size cap
// ──────────────────────────────────────────────────────────────────────────

/**
 * Maximum allowed byte size for `progress.txt`.
 *
 * Reads `OMCP_PROGRESS_MAX_BYTES` from the environment; falls back to 64 KiB.
 * The value is intentionally re-read on every call so tests can override it
 * without module-level caching.
 */
function progressCapBytes(): number {
  const raw = process.env["OMCP_PROGRESS_MAX_BYTES"];
  if (raw !== undefined) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 65536; // 64 KiB default
}

/**
 * Truncate `content` to at most `capBytes` bytes, preserving whole entries.
 *
 * Entries are delimited by lines that start with `##`. When the content
 * exceeds `capBytes`, the function finds the earliest `##` header boundary
 * that keeps the remaining content within the cap and discards everything
 * before it. If a single entry is itself larger than `capBytes`, the tail
 * `capBytes` bytes of that entry are returned (still bounded).
 */
export function truncateProgressContent(
  content: string,
  capBytes: number,
): string {
  const buf = Buffer.from(content, "utf-8");
  if (buf.byteLength <= capBytes) return content;

  // Walk forward through `##` entry boundaries and find the first one whose
  // tail fits within capBytes.
  const lines = content.split("\n");
  let byteOffset = 0;
  let cutByteOffset = -1; // byte position of the best `##` boundary found

  for (let i = 0; i < lines.length; i++) {
    const lineBytes = Buffer.byteLength(lines[i]!, "utf-8") + 1; // +1 for \n
    if (lines[i]!.startsWith("##")) {
      const remaining = buf.byteLength - byteOffset;
      if (remaining <= capBytes) {
        cutByteOffset = byteOffset;
        break;
      }
    }
    byteOffset += lineBytes;
  }

  if (cutByteOffset >= 0) {
    return buf.subarray(cutByteOffset).toString("utf-8");
  }

  // No `##` boundary found that fits — return the raw tail bytes.
  return buf.subarray(buf.byteLength - capBytes).toString("utf-8");
}

/**
 * Append a free-form progress entry to `.omcp/progress.txt`.
 *
 * The entry is prefixed with a header containing the ISO timestamp and an
 * optional story id, followed by the entry body and a blank-line
 * separator. Returns false if the write fails.
 *
 * After appending, the file is truncated to the configured cap
 * (`OMCP_PROGRESS_MAX_BYTES` env var, default 64 KiB) by dropping the
 * oldest whole entries first (rolling-tail behaviour).
 */
export function appendProgressNote(
  entry: string,
  worktreeRoot?: string,
  storyId?: string,
): boolean {
  const file = progressPath(worktreeRoot);
  try {
    ensureOmcpDir(".", worktreeRoot);
    const dir = dirname(file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const existing = existsSync(file) ? readFileSync(file, "utf-8") : "";
    const header = storyId
      ? `## ${new Date().toISOString()} — ${storyId}`
      : `## ${new Date().toISOString()}`;
    const next = `${existing}${existing && !existing.endsWith("\n") ? "\n" : ""}${header}\n${entry}\n\n`;

    const capped = truncateProgressContent(next, progressCapBytes());
    atomicWriteFileSync(file, capped);
    return true;
  } catch {
    return false;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Context formatting
// ──────────────────────────────────────────────────────────────────────────

function formatNextStoryPrompt(story: UserStory): string {
  return `<current-story>

## Current Story: ${story.id} - ${story.title}

${story.description}

**Acceptance Criteria:**
${story.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}

**Instructions:**
1. Implement this story completely
2. Verify ALL acceptance criteria are met with fresh evidence
3. When complete, set passes: true on this story in the PRD
4. If ALL stories are done, run \`/oh-my-copilot:cancel\` to exit cleanly

</current-story>
`;
}

function formatPrdStatusSummary(status: PRDStatus): string {
  const lines: string[] = [];
  lines.push(`[PRD Status: ${status.completed}/${status.total} stories complete]`);
  if (status.allComplete) {
    lines.push("All stories are COMPLETE!");
  } else {
    lines.push(`Remaining: ${status.incompleteIds.join(", ")}`);
    if (status.nextStory) {
      lines.push(
        `Next story: ${status.nextStory.id} - ${status.nextStory.title}`,
      );
    }
  }
  return lines.join("\n");
}

/**
 * Build the context block injected into the next ralph iteration.
 *
 * The block concatenates (in order):
 *   1. Prior progress notes (if any)
 *   2. The next-story prompt (if a PRD with pending stories exists)
 *   3. The current PRD status summary
 *
 * Returns an empty string when none of the three are present.
 */
export function getRalphContext(worktreeRoot?: string): string {
  const parts: string[] = [];

  const progress = readProgressNotes(worktreeRoot);
  if (progress.trim()) {
    parts.push(`<progress-notes>\n${progress.trimEnd()}\n</progress-notes>\n`);
  }

  const prdStatus = getPrdCompletionStatus(worktreeRoot);
  if (prdStatus.hasPrd && prdStatus.nextStory) {
    parts.push(formatNextStoryPrompt(prdStatus.nextStory));
  }
  if (prdStatus.status) {
    parts.push(
      `<prd-status>\n${formatPrdStatusSummary(prdStatus.status)}\n</prd-status>\n`,
    );
  }

  return parts.join("\n");
}

// ──────────────────────────────────────────────────────────────────────────
// Reviewer verdict detection
// ──────────────────────────────────────────────────────────────────────────

/**
 * Detect a reviewer-approval sentinel in free-form output.
 *
 * Matches the omc verifier conventions:
 *   `<architect-approved>VERIFIED_COMPLETE</architect-approved>` and
 *   `<ralph-approved critic="…">VERIFIED_COMPLETE</ralph-approved>`.
 *
 * Both tags carry the same semantic — work has cleared the configured
 * reviewer — and either should flip `architectApproved` on the state.
 */
export function detectArchitectApproval(text: string): boolean {
  return /<(?:architect-approved|ralph-approved)(?:\s+[^>]*)?>[^<]*VERIFIED_COMPLETE[^<]*<\/(?:architect-approved|ralph-approved)>/is.test(
    text,
  );
}

/**
 * Parse a structured verdict keyword from free-form reviewer output.
 *
 * Strictness rule: the verdict keyword (APPROVE / ITERATE / REJECT) must be
 * the sole significant token on a line. Leading/trailing whitespace and
 * optional markdown bold markers (`**APPROVE**`) are tolerated. Inline
 * occurrences such as "I would APPROVE this if X" or "REJECT the alternative"
 * do NOT match. Case-insensitive. If a single line contains more than one
 * verdict keyword the result is ambiguous → returns null.
 *
 * Returns null when no unambiguous verdict keyword line is found.
 */
export function detectVerdict(
  text: string,
): "APPROVE" | "ITERATE" | "REJECT" | null {
  const KEYWORDS = ["APPROVE", "ITERATE", "REJECT"] as const;
  // Strip optional markdown bold wrapper, then check that nothing else remains
  // on the line beyond whitespace.
  const LINE_RE = /^\s*(?:\*\*)?\s*(APPROVE|ITERATE|REJECT)\s*(?:\*\*)?\s*$/i;

  for (const raw of text.split("\n")) {
    const m = LINE_RE.exec(raw);
    if (!m) continue;
    // Verify the line does not contain a second verdict keyword after stripping
    // the matched one (ambiguous line guard).
    const stripped = raw.replace(new RegExp(m[1], "gi"), "").replace(/\*+/g, "");
    const hasSecond = KEYWORDS.some(
      (kw) => kw !== m[1].toUpperCase() && new RegExp(`\\b${kw}\\b`, "i").test(stripped),
    );
    if (hasSecond) return null;
    return m[1].toUpperCase() as "APPROVE" | "ITERATE" | "REJECT";
  }
  return null;
}

/**
 * Detect a reviewer-rejection signal and surface a short feedback excerpt.
 *
 * Heuristic, not exhaustive: matches common phrasings ("architect rejected",
 * "issues found", "not yet complete", "missing implementation", "bug
 * detected", "error identified"). Returns `{rejected: false, feedback: ""}`
 * when no rejection pattern fires.
 */
export function detectArchitectRejection(
  text: string,
): { rejected: boolean; feedback: string } {
  const rejectionPatterns: RegExp[] = [
    /(architect|critic|codex|reviewer).*?(rejected|found issues|not complete|incomplete)/i,
    /issues? (found|identified|detected)/i,
    /not yet complete/i,
    /missing.*?(implementation|feature|test)/i,
    /bug.*?(found|detected|identified)/i,
    /error.*?(found|detected|identified)/i,
  ];

  for (const pattern of rejectionPatterns) {
    if (pattern.test(text)) {
      const feedbackMatch = text.match(
        /(?:architect|critic|codex|reviewer|feedback|issue|problem|error|bug)[:\s]+([^.]+\.)/i,
      );
      return {
        rejected: true,
        feedback: feedbackMatch
          ? feedbackMatch[1].trim()
          : "Reviewer reported issues with the implementation.",
      };
    }
  }
  return { rejected: false, feedback: "" };
}

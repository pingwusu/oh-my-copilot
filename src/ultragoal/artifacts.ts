// Ultragoal artifact management for omcp.
//
// Adapted from omx's src/ultragoal/artifacts.ts — key differences:
//   - Uses `.omcp/ultragoal/` instead of `.omx/ultragoal/`
//   - Codex goal integration stubs replaced with Copilot-facing handoff text
//   - No dependency on omx's goal-workflows/codex-goal-snapshot module
//   - Checkpoint requires evidence string; codexGoal + qualityGate are recorded
//     as opaque JSON blobs (no snapshot reconciliation against Copilot internals)

import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { atomicWriteFileSync } from "../runtime/atomic-write.js";

export const ULTRAGOAL_DIR = ".omcp/ultragoal";
export const ULTRAGOAL_BRIEF = "brief.md";
export const ULTRAGOAL_GOALS = "goals.json";
export const ULTRAGOAL_LEDGER = "ledger.jsonl";

export type UltragoalStatus =
  | "pending"
  | "in_progress"
  | "complete"
  | "failed"
  | "review_blocked";

export type UltragoalCodexGoalMode = "aggregate" | "per_story";

export interface UltragoalItem {
  id: string;
  title: string;
  objective: string;
  status: UltragoalStatus;
  tokenBudget?: number;
  attempt: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  failedAt?: string;
  reviewBlockedAt?: string;
  evidence?: string;
  failureReason?: string;
}

export interface UltragoalAggregateCompletion {
  status: "complete";
  completedAt: string;
  evidence: string;
}

export interface UltragoalPlan {
  version: 1;
  createdAt: string;
  updatedAt: string;
  briefPath: string;
  goalsPath: string;
  ledgerPath: string;
  codexGoalMode?: UltragoalCodexGoalMode;
  codexObjective?: string;
  aggregateCompletion?: UltragoalAggregateCompletion;
  activeGoalId?: string;
  goals: UltragoalItem[];
}

export interface UltragoalLedgerEntry {
  ts: string;
  event:
    | "plan_created"
    | "goal_started"
    | "goal_resumed"
    | "goal_completed"
    | "goal_blocked"
    | "goal_failed"
    | "goal_retried"
    | "aggregate_completed"
    | "goal_added"
    | "final_review_failed"
    | "goal_review_blocked";
  goalId?: string;
  status?: UltragoalStatus;
  message?: string;
  evidence?: string;
}

export interface UltragoalQualityGate {
  aiSlopCleaner: { status: "passed"; evidence: string };
  verification: { status: "passed"; commands: string[]; evidence: string };
  codeReview: {
    recommendation: "APPROVE";
    architectStatus: "CLEAR";
    evidence: string;
  };
}

export interface CreateUltragoalOptions {
  brief: string;
  goals?: Array<{ title?: string; objective: string; tokenBudget?: number }>;
  codexGoalMode?: UltragoalCodexGoalMode;
  now?: Date;
  force?: boolean;
}

export interface StartNextOptions {
  now?: Date;
  retryFailed?: boolean;
}

export interface CheckpointOptions {
  goalId: string;
  status: "complete" | "failed";
  evidence?: string;
  qualityGate?: unknown;
  now?: Date;
}

export interface AddUltragoalGoalOptions {
  title: string;
  objective: string;
  evidence?: string;
  now?: Date;
}

export interface RecordFinalReviewBlockersOptions
  extends AddUltragoalGoalOptions {
  goalId: string;
}

export class UltragoalError extends Error {}

function iso(now = new Date()): string {
  return now.toISOString();
}

export function ultragoalDir(cwd: string): string {
  return join(cwd, ULTRAGOAL_DIR);
}

export function ultragoalBriefPath(cwd: string): string {
  return join(ultragoalDir(cwd), ULTRAGOAL_BRIEF);
}

export function ultragoalGoalsPath(cwd: string): string {
  return join(ultragoalDir(cwd), ULTRAGOAL_GOALS);
}

export function ultragoalLedgerPath(cwd: string): string {
  return join(ultragoalDir(cwd), ULTRAGOAL_LEDGER);
}

function repoRelative(cwd: string, path: string): string {
  return relative(cwd, path).split("\\").join("/");
}

function cleanLine(line: string): string {
  return line.replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/, "").trim();
}

function titleFromObjective(objective: string, fallback: string): string {
  const firstLine =
    objective
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean) ?? fallback;
  return firstLine.length > 72
    ? `${firstLine.slice(0, 69).trimEnd()}...`
    : firstLine;
}

export function deriveGoalCandidates(
  brief: string,
): Array<{ title: string; objective: string }> {
  const lines = brief.split(/\r?\n/);
  const bulletGoals = lines
    .map((line) => ({ original: line, cleaned: cleanLine(line) }))
    .filter(
      ({ cleaned }) => cleaned.length > 0 && cleaned.length <= 1200,
    )
    .filter(
      ({ original, cleaned }, index, all) =>
        /^\s*(?:[-*+]\s+|\d+[.)]\s+)/.test(original) &&
        all.findIndex((c) => c.cleaned === cleaned) === index,
    )
    .map(({ cleaned }) => cleaned);

  const objectives =
    bulletGoals.length > 0
      ? bulletGoals
      : brief
          .split(/\n\s*\n/)
          .map((p) => p.trim())
          .filter((p) => p.length > 0 && !p.startsWith("#"));

  const selected =
    objectives.length > 0
      ? objectives
      : [brief.trim() || "Complete the requested project objective."];
  return selected.map((objective, index) => ({
    title: titleFromObjective(objective, `Goal ${index + 1}`),
    objective,
  }));
}

function normalizeGoalId(title: string, index: number): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36)
    .replace(/-+$/g, "");
  return `G${String(index + 1).padStart(3, "0")}${slug ? `-${slug}` : ""}`;
}

async function appendLedger(
  cwd: string,
  entry: UltragoalLedgerEntry,
): Promise<void> {
  await mkdir(ultragoalDir(cwd), { recursive: true });
  await appendFile(ultragoalLedgerPath(cwd), `${JSON.stringify(entry)}\n`);
}

export async function readUltragoalPlan(cwd: string): Promise<UltragoalPlan> {
  const path = ultragoalGoalsPath(cwd);
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch {
    throw new UltragoalError(
      `No ultragoal plan found at ${repoRelative(cwd, path)}. Run \`omcp ultragoal create-goals ...\` first.`,
    );
  }
  const parsed = JSON.parse(raw) as UltragoalPlan;
  if (parsed.version !== 1 || !Array.isArray(parsed.goals)) {
    throw new UltragoalError(
      `Invalid ultragoal plan at ${repoRelative(cwd, path)}.`,
    );
  }
  return parsed;
}

async function writePlan(cwd: string, plan: UltragoalPlan): Promise<void> {
  await mkdir(ultragoalDir(cwd), { recursive: true });
  // DD8 Critic-A P1 fix: previously used fs/promises.writeFile (non-atomic).
  // A crash mid-write bricked goals.json and the entire ultragoal workflow.
  atomicWriteFileSync(
    ultragoalGoalsPath(cwd),
    `${JSON.stringify(plan, null, 2)}\n`,
  );
}

function aggregateCodexObjective(goals: readonly UltragoalItem[]): string {
  const prefix = `Complete all ultragoal stories in ${ULTRAGOAL_DIR}/${ULTRAGOAL_GOALS}: `;
  const suffix = goals.map((g) => `${g.id} ${g.title}`).join("; ");
  const full = `${prefix}${suffix}`;
  if (full.length <= 4000) return full;
  return `Complete all ultragoal stories listed in ${ULTRAGOAL_DIR}/${ULTRAGOAL_GOALS}. Use ${ULTRAGOAL_DIR}/${ULTRAGOAL_LEDGER} as the durable audit trail.`;
}

export async function createUltragoalPlan(
  cwd: string,
  options: CreateUltragoalOptions,
): Promise<UltragoalPlan> {
  if (!options.force && existsSync(ultragoalGoalsPath(cwd))) {
    throw new UltragoalError(
      `Refusing to overwrite existing ${ULTRAGOAL_DIR}/${ULTRAGOAL_GOALS}; pass --force to recreate it.`,
    );
  }
  const now = iso(options.now);
  const sourceGoals: Array<{
    title?: string;
    objective: string;
    tokenBudget?: number;
  }> = options.goals?.length ? options.goals : deriveGoalCandidates(options.brief);
  const candidates = sourceGoals.map(
    (goal, index): UltragoalItem => ({
      id: normalizeGoalId(
        goal.title ?? titleFromObjective(goal.objective, `Goal ${index + 1}`),
        index,
      ),
      title:
        goal.title ?? titleFromObjective(goal.objective, `Goal ${index + 1}`),
      objective: goal.objective.trim(),
      status: "pending",
      tokenBudget: goal.tokenBudget,
      attempt: 0,
      createdAt: now,
      updatedAt: now,
    }),
  );

  const plan: UltragoalPlan = {
    version: 1,
    createdAt: now,
    updatedAt: now,
    briefPath: `${ULTRAGOAL_DIR}/${ULTRAGOAL_BRIEF}`,
    goalsPath: `${ULTRAGOAL_DIR}/${ULTRAGOAL_GOALS}`,
    ledgerPath: `${ULTRAGOAL_DIR}/${ULTRAGOAL_LEDGER}`,
    codexGoalMode: options.codexGoalMode ?? "aggregate",
    goals: candidates,
  };
  if (plan.codexGoalMode === "aggregate") {
    plan.codexObjective = aggregateCodexObjective(candidates);
  }

  await mkdir(ultragoalDir(cwd), { recursive: true });
  atomicWriteFileSync(
    ultragoalBriefPath(cwd),
    options.brief.endsWith("\n") ? options.brief : `${options.brief}\n`,
  );
  await writePlan(cwd, plan);
  atomicWriteFileSync(ultragoalLedgerPath(cwd), "");
  await appendLedger(cwd, {
    ts: now,
    event: "plan_created",
    message: `${candidates.length} goal(s) created`,
  });
  return plan;
}

export function summarizeUltragoalPlan(plan: UltragoalPlan): {
  total: number;
  pending: number;
  inProgress: number;
  complete: number;
  failed: number;
  reviewBlocked: number;
  aggregateComplete: boolean;
  activeGoalId?: string;
} {
  return {
    total: plan.goals.length,
    pending: plan.goals.filter((g) => g.status === "pending").length,
    inProgress: plan.goals.filter((g) => g.status === "in_progress").length,
    complete: plan.goals.filter((g) => g.status === "complete").length,
    failed: plan.goals.filter((g) => g.status === "failed").length,
    reviewBlocked: plan.goals.filter((g) => g.status === "review_blocked")
      .length,
    aggregateComplete: plan.aggregateCompletion?.status === "complete",
    activeGoalId: plan.activeGoalId,
  };
}

function isResolvedStatus(status: UltragoalStatus): boolean {
  return status === "complete" || status === "review_blocked";
}

export function isUltragoalDone(plan: UltragoalPlan): boolean {
  if (plan.aggregateCompletion?.status === "complete") return true;
  if (plan.goals.length === 0) return true;
  if (
    plan.goals.some(
      (g) =>
        g.status === "pending" ||
        g.status === "in_progress" ||
        g.status === "failed",
    )
  )
    return false;
  if (!plan.goals.every((g) => isResolvedStatus(g.status))) return false;
  const latest = [...plan.goals]
    .reverse()
    .find((g) => g.status !== "review_blocked");
  return latest?.status === "complete";
}

export function isFinalRunCompletionCandidate(
  plan: UltragoalPlan,
  goal: UltragoalItem,
): boolean {
  return plan.goals.every(
    (c) => c.id === goal.id || isResolvedStatus(c.status),
  );
}

function assertNonEmpty(
  value: string | undefined,
  label: string,
): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new UltragoalError(`Missing ${label}.`);
  return trimmed;
}

function appendGoalToPlan(
  plan: UltragoalPlan,
  options: AddUltragoalGoalOptions,
  now: string,
): UltragoalItem {
  const title = assertNonEmpty(options.title, "--title");
  const objective = assertNonEmpty(options.objective, "--objective");
  const goal: UltragoalItem = {
    id: normalizeGoalId(title, plan.goals.length),
    title,
    objective,
    status: "pending",
    attempt: 0,
    createdAt: now,
    updatedAt: now,
    evidence: options.evidence,
  };
  plan.goals.push(goal);
  plan.updatedAt = now;
  return goal;
}

export async function addUltragoalGoal(
  cwd: string,
  options: AddUltragoalGoalOptions,
): Promise<{ plan: UltragoalPlan; goal: UltragoalItem }> {
  const plan = await readUltragoalPlan(cwd);
  const now = iso(options.now);
  const goal = appendGoalToPlan(plan, options, now);
  await writePlan(cwd, plan);
  await appendLedger(cwd, {
    ts: now,
    event: "goal_added",
    goalId: goal.id,
    status: goal.status,
    evidence: options.evidence,
    message: goal.title,
  });
  return { plan, goal };
}

export async function startNextUltragoal(
  cwd: string,
  options: StartNextOptions = {},
): Promise<{
  plan: UltragoalPlan;
  goal: UltragoalItem | null;
  resumed: boolean;
  done: boolean;
}> {
  const plan = await readUltragoalPlan(cwd);
  const now = iso(options.now);
  if (plan.aggregateCompletion?.status === "complete") {
    return { plan, goal: null, resumed: false, done: true };
  }
  const existing = plan.goals.find((g) => g.status === "in_progress");
  if (existing) {
    await appendLedger(cwd, {
      ts: now,
      event: "goal_resumed",
      goalId: existing.id,
      status: existing.status,
      message: "Resuming active ultragoal",
    });
    return { plan, goal: existing, resumed: true, done: false };
  }

  let next = plan.goals.find((g) => g.status === "pending");
  if (!next && options.retryFailed) {
    next = plan.goals.find((g) => g.status === "failed");
    if (next) {
      await appendLedger(cwd, {
        ts: now,
        event: "goal_retried",
        goalId: next.id,
        status: "pending",
        message: next.failureReason,
      });
    }
  }
  if (!next) {
    return { plan, goal: null, resumed: false, done: isUltragoalDone(plan) };
  }

  next.status = "in_progress";
  next.attempt += 1;
  next.startedAt = now;
  next.failedAt = undefined;
  next.failureReason = undefined;
  next.updatedAt = now;
  plan.activeGoalId = next.id;
  plan.updatedAt = now;
  await writePlan(cwd, plan);
  await appendLedger(cwd, {
    ts: now,
    event: "goal_started",
    goalId: next.id,
    status: next.status,
    message: `Attempt ${next.attempt}`,
  });
  return { plan, goal: next, resumed: false, done: false };
}

function validateQualityGate(value: unknown): UltragoalQualityGate {
  if (!value || typeof value !== "object") {
    throw new UltragoalError(
      "Final ultragoal completion requires --quality-gate-json with ai-slop-cleaner, verification, and code-review evidence.",
    );
  }
  const gate = value as Partial<UltragoalQualityGate>;
  const cleaner = gate.aiSlopCleaner;
  const verification = gate.verification;
  const review = gate.codeReview;
  if (!cleaner || typeof cleaner !== "object") {
    throw new UltragoalError(
      "Final quality gate is missing aiSlopCleaner evidence.",
    );
  }
  if (cleaner.status !== "passed") {
    throw new UltragoalError(
      'Final quality gate requires aiSlopCleaner.status="passed".',
    );
  }
  assertNonEmpty(cleaner.evidence, "aiSlopCleaner.evidence");
  if (!verification || typeof verification !== "object") {
    throw new UltragoalError(
      "Final quality gate is missing verification evidence.",
    );
  }
  if (verification.status !== "passed") {
    throw new UltragoalError(
      'Final quality gate requires verification.status="passed".',
    );
  }
  if (
    !Array.isArray(verification.commands) ||
    verification.commands.length === 0 ||
    verification.commands.some(
      (c) => typeof c !== "string" || c.trim() === "",
    )
  ) {
    throw new UltragoalError(
      "Final quality gate requires non-empty verification.commands.",
    );
  }
  assertNonEmpty(verification.evidence, "verification.evidence");
  if (!review || typeof review !== "object") {
    throw new UltragoalError(
      "Final quality gate is missing codeReview evidence.",
    );
  }
  if (review.recommendation !== "APPROVE") {
    throw new UltragoalError(
      "Final code-review must be clean: codeReview.recommendation must be APPROVE.",
    );
  }
  if (review.architectStatus !== "CLEAR") {
    throw new UltragoalError(
      "Final code-review must be clean: codeReview.architectStatus must be CLEAR.",
    );
  }
  assertNonEmpty(review.evidence, "codeReview.evidence");
  return gate as UltragoalQualityGate;
}

export async function checkpointUltragoal(
  cwd: string,
  options: CheckpointOptions,
): Promise<UltragoalPlan> {
  const plan = await readUltragoalPlan(cwd);
  const goal = plan.goals.find((c) => c.id === options.goalId);
  if (!goal) {
    throw new UltragoalError(`Unknown ultragoal id: ${options.goalId}`);
  }
  const now = iso(options.now);

  const finalCandidate = isFinalRunCompletionCandidate(plan, goal);
  const qualityGate =
    options.status === "complete" && finalCandidate
      ? validateQualityGate(options.qualityGate)
      : undefined;

  goal.status = options.status;
  goal.updatedAt = now;
  if (options.status === "complete") {
    goal.completedAt = now;
    goal.evidence = options.evidence;
    goal.failureReason = undefined;
    goal.failedAt = undefined;
    if (plan.activeGoalId === goal.id) delete plan.activeGoalId;
    if (finalCandidate) {
      plan.aggregateCompletion = {
        status: "complete",
        completedAt: now,
        evidence: options.evidence ?? "",
      };
    }
  } else {
    goal.failedAt = now;
    goal.failureReason = options.evidence;
    if (plan.activeGoalId === goal.id) delete plan.activeGoalId;
  }
  plan.updatedAt = now;
  await writePlan(cwd, plan);
  await appendLedger(cwd, {
    ts: now,
    event: options.status === "complete" ? "goal_completed" : "goal_failed",
    goalId: goal.id,
    status: goal.status,
    evidence: options.evidence,
    message: qualityGate ? "quality-gate passed" : undefined,
  });
  return plan;
}

export async function recordFinalReviewBlockers(
  cwd: string,
  options: RecordFinalReviewBlockersOptions,
): Promise<{
  plan: UltragoalPlan;
  blockedGoal: UltragoalItem;
  addedGoal: UltragoalItem;
}> {
  const plan = await readUltragoalPlan(cwd);
  const goal = plan.goals.find((c) => c.id === options.goalId);
  if (!goal) {
    throw new UltragoalError(`Unknown ultragoal id: ${options.goalId}`);
  }
  assertNonEmpty(options.evidence, "--evidence");
  if (goal.status !== "in_progress") {
    throw new UltragoalError(
      `Cannot record final review blockers for ${goal.id} while it is ${goal.status}; start or resume the ultragoal first.`,
    );
  }
  if (!isFinalRunCompletionCandidate(plan, goal)) {
    throw new UltragoalError(
      `Cannot record final review blockers for ${goal.id}; it is not the only unresolved ultragoal story.`,
    );
  }

  const now = iso(options.now);
  const addedGoal = appendGoalToPlan(plan, options, now);
  goal.status = "review_blocked";
  goal.reviewBlockedAt = now;
  goal.updatedAt = now;
  goal.completedAt = undefined;
  goal.failedAt = undefined;
  goal.failureReason = undefined;
  goal.evidence = options.evidence;
  if (plan.activeGoalId === goal.id) delete plan.activeGoalId;
  plan.updatedAt = now;

  await writePlan(cwd, plan);
  await appendLedger(cwd, {
    ts: now,
    event: "final_review_failed",
    goalId: goal.id,
    status: goal.status,
    evidence: options.evidence,
    message: "Final code-review was not clean; blocker story appended.",
  });
  await appendLedger(cwd, {
    ts: now,
    event: "goal_added",
    goalId: addedGoal.id,
    status: addedGoal.status,
    evidence: options.evidence,
    message: addedGoal.title,
  });
  await appendLedger(cwd, {
    ts: now,
    event: "goal_review_blocked",
    goalId: goal.id,
    status: goal.status,
    evidence: options.evidence,
  });
  return { plan, blockedGoal: goal, addedGoal };
}

export function buildGoalInstruction(
  goal: UltragoalItem,
  plan: UltragoalPlan,
): string {
  const mode = plan.codexGoalMode ?? "aggregate";
  const finalStory = isFinalRunCompletionCandidate(plan, goal);
  const objective =
    mode === "aggregate"
      ? (plan.codexObjective ?? aggregateCodexObjective(plan.goals))
      : goal.objective;

  const lines = [
    `Ultragoal ${mode === "aggregate" ? "aggregate-goal" : "active-goal"} handoff`,
    `Plan: ${plan.goalsPath}`,
    `Ledger: ${plan.ledgerPath}`,
    `Goal: ${goal.id} — ${goal.title}`,
    "",
    "Story objective:",
    goal.objective,
    "",
    mode === "aggregate" ? "Aggregate objective:" : null,
    mode === "aggregate" ? objective : null,
    mode === "aggregate" ? "" : null,
    "Completion constraints:",
    "- Work only this goal until its completion audit passes.",
    finalStory
      ? "- Final mandatory quality gate: run /oh-my-copilot:ai-slop-cleaner on changed files, rerun verification, then run /oh-my-copilot:requesting-code-review."
      : "- This is not the final story; do not run the final ai-slop-cleaner/code-review gate yet.",
    finalStory
      ? "- If final code-review is not APPROVE+CLEAR, record blockers with:"
      : "- After the goal is complete, checkpoint the ledger with:",
    finalStory
      ? `  omcp ultragoal record-review-blockers --goal-id ${goal.id} --title "Resolve final code-review blockers" --objective "<blocker-resolution objective>" --evidence "<review findings>"`
      : `  omcp ultragoal checkpoint --goal-id ${goal.id} --status complete --evidence "<tests/files evidence>"`,
    finalStory
      ? `- If final code-review is clean, checkpoint with --quality-gate-json:`
      : null,
    finalStory
      ? `  omcp ultragoal checkpoint --goal-id ${goal.id} --status complete --evidence "<tests/files evidence>" --quality-gate-json "<quality gate JSON or path>"`
      : null,
    "- If blocked or failed, checkpoint with --status failed and the failure evidence.",
  ].filter((l): l is string => l !== null);

  return lines.join("\n");
}

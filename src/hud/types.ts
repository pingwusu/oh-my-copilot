// Shared types for the omcp HUD rendering pipeline.

export type ModelFamily = "claude" | "gpt";

export interface HudThresholds {
  contextWarning: number;
  contextCompactSuggestion: number;
  contextCritical: number;
  ralphWarning: number;
}

export const DEFAULT_THRESHOLDS: HudThresholds = {
  contextWarning: 70,
  contextCompactSuggestion: 80,
  contextCritical: 90,
  ralphWarning: 7,
};

export interface RalphStateForHud {
  active: boolean;
  iteration: number;
  maxIterations: number;
}

export interface AutopilotPhase {
  name: string;
}

export interface AutopilotStateForHud {
  active: boolean;
  phase: string;
  iteration: number;
  maxIterations: number;
  tasksCompleted?: number;
  tasksTotal?: number;
  filesCreated?: number;
}

export interface TeamStateForHud {
  active: boolean;
  spawned: number;
  done: number;
}

export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed" | string;
  activeForm?: string;
}

export interface TokenUsageForHud {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
}

export interface GitInfo {
  repo: string | null;
  branch: string | null;
}

export interface PrdProgressForHud {
  completed: number;
  total: number;
}

export interface ModeIterForHud {
  /** Primary active mode name (e.g. "ralph", "autopilot"). */
  modeName: string;
  /** Current outer-loop iteration (1-based). */
  iteration: number;
  /** Max iterations for the outer loop. */
  maxIterations: number;
}

export interface HudState {
  cwd: string;
  env: NodeJS.ProcessEnv;
  modelFamily: ModelFamily;
  modelName: string | null;
  activeModes: string[];
  ralph: RalphStateForHud | null;
  autopilot: AutopilotStateForHud | null;
  team: TeamStateForHud | null;
  todos: TodoItem[];
  contextPercent: number | null;
  tokens: TokenUsageForHud | null;
  sessionTotalTokens: number | null;
  priorityNote: string | null;
  thresholds: HudThresholds;
  /** Column 1: primary mode + iteration (null when no looping mode active). */
  modeIter: ModeIterForHud | null;
  /** Column 2: PRD progress fraction (null when no PRD present). */
  prd: PrdProgressForHud | null;
  /** Column 6: estimated cost total across all outer-loop iterations (0 = placeholder). */
  estimatedCostTotal: number;
}

export interface HudElement {
  (state: HudState): string | null;
}

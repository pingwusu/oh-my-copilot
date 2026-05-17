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
}

export interface HudElement {
  (state: HudState): string | null;
}

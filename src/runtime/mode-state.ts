// Typed mode state — mirrors omc's mode-registry pattern.
//
// Tracks "active mode" (ralph, autopilot, ultrawork, ultraqa, team, sciomc)
// across context compactions by persisting JSON state under .omcp/state/.
//
// Each mode has its own state schema. The MODE_CONFIGS map enforces mutual
// exclusion: only one mutually-exclusive mode may be active at a time.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export type ModeName =
  | "ralph"
  | "autopilot"
  | "ultrawork"
  | "ultraqa"
  | "team"
  | "sciomc"
  | "ralplan";

export interface BaseModeState {
  active: boolean;
  session_id: string;
  started_at: string;
  prompt?: string;
}

export interface RalphLoopState extends BaseModeState {
  iteration: number;
  max_iterations: number;
}

export interface AutopilotState extends BaseModeState {
  phase:
    | "expansion"
    | "planning"
    | "execution"
    | "qa"
    | "validation"
    | "cleanup";
  iteration: number;
  ralph_iterations?: number;
  ultraqa_cycles?: number;
}

export interface TeamState extends BaseModeState {
  spawned: number;
  done: number;
  workers: Array<{ id: string; agent?: string; status: string }>;
}

export interface ModeConfig {
  mutuallyExclusive: boolean;
}

export const MODE_CONFIGS: Record<ModeName, ModeConfig> = {
  ralph: { mutuallyExclusive: true },
  autopilot: { mutuallyExclusive: true },
  ultrawork: { mutuallyExclusive: true },
  ultraqa: { mutuallyExclusive: true },
  team: { mutuallyExclusive: false },
  sciomc: { mutuallyExclusive: false },
  ralplan: { mutuallyExclusive: false },
};

function stateRoot(): string {
  return join(process.cwd(), ".omcp", "state");
}

function modeFile(mode: ModeName): string {
  return join(stateRoot(), `${mode}-state.json`);
}

export function readModeState<T extends BaseModeState>(mode: ModeName): T | null {
  const f = modeFile(mode);
  if (!existsSync(f)) return null;
  try {
    return JSON.parse(readFileSync(f, "utf8")) as T;
  } catch {
    return null;
  }
}

export function writeModeState<T extends BaseModeState>(
  mode: ModeName,
  state: T,
): void {
  const f = modeFile(mode);
  mkdirSync(stateRoot(), { recursive: true });
  writeFileSync(f, JSON.stringify(state, null, 2));
}

export function clearModeState(mode: ModeName): void {
  const f = modeFile(mode);
  if (existsSync(f)) rmSync(f);
}

export function listActiveModes(): ModeName[] {
  const root = stateRoot();
  if (!existsSync(root)) return [];
  const out: ModeName[] = [];
  for (const mode of Object.keys(MODE_CONFIGS) as ModeName[]) {
    const s = readModeState<BaseModeState>(mode);
    if (s?.active) out.push(mode);
  }
  return out;
}

export function canStartMode(target: ModeName): {
  ok: boolean;
  conflict?: ModeName;
} {
  if (!MODE_CONFIGS[target].mutuallyExclusive) return { ok: true };
  const active = listActiveModes().find(
    (m) => MODE_CONFIGS[m].mutuallyExclusive && m !== target,
  );
  if (active) return { ok: false, conflict: active };
  return { ok: true };
}

export function isCancelled(): boolean {
  return existsSync(join(stateRoot(), "cancel.json"));
}

export function clearCancel(): void {
  const f = join(stateRoot(), "cancel.json");
  if (existsSync(f)) rmSync(f);
}

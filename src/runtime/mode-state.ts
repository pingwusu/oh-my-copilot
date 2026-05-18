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
} from "node:fs";
import { join } from "node:path";
import { atomicWriteFileSync } from "./atomic-write.js";
import { assertSafeSlug } from "./safe-slug.js";

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

export function resolveSessionRoot(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const sid = env.COPILOT_SESSION_ID ?? env.OMCP_SESSION_ID;
  if (typeof sid === "string" && sid.length > 0) return sid;
  return "default";
}

function stateRoot(sessionId?: string): string {
  if (sessionId === "") {
    return join(process.cwd(), ".omcp", "state");
  }
  const sid = sessionId ?? resolveSessionRoot();
  if (sid === "default") {
    return join(process.cwd(), ".omcp", "state");
  }
  return join(process.cwd(), ".omcp", "state", "sessions", sid);
}

function modeFile(mode: ModeName, sessionId?: string): string {
  // DD4 Lane B fix: ModeName is a typed enum and sessionId is validated via
  // resolveSessionRoot, but defense-in-depth — refuse any callers that
  // bypass typing.
  assertSafeSlug(mode, "mode");
  if (sessionId !== undefined && sessionId !== "") {
    assertSafeSlug(sessionId, "sessionId");
  }
  return join(stateRoot(sessionId), `${mode}-state.json`);
}

export function readModeState<T extends BaseModeState>(
  mode: ModeName,
  sessionId?: string,
): T | null {
  const f = modeFile(mode, sessionId);
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
  sessionId?: string,
): void {
  const f = modeFile(mode, sessionId);
  mkdirSync(stateRoot(sessionId), { recursive: true });
  atomicWriteFileSync(f, JSON.stringify(state, null, 2));
}

export function clearModeState(mode: ModeName, sessionId?: string): void {
  const f = modeFile(mode, sessionId);
  if (existsSync(f)) rmSync(f);
}

export function listActiveModes(sessionId?: string): ModeName[] {
  const root = stateRoot(sessionId);
  if (!existsSync(root)) return [];
  const out: ModeName[] = [];
  for (const mode of Object.keys(MODE_CONFIGS) as ModeName[]) {
    const s = readModeState<BaseModeState>(mode, sessionId);
    if (s?.active) out.push(mode);
  }
  return out;
}

export function canStartMode(
  target: ModeName,
  sessionId?: string,
): {
  ok: boolean;
  conflict?: ModeName;
} {
  if (!MODE_CONFIGS[target].mutuallyExclusive) return { ok: true };
  const active = listActiveModes(sessionId).find(
    (m) => MODE_CONFIGS[m].mutuallyExclusive && m !== target,
  );
  if (active) return { ok: false, conflict: active };
  return { ok: true };
}

export function isCancelled(sessionId?: string): boolean {
  return existsSync(join(stateRoot(sessionId), "cancel.json"));
}

export function clearCancel(sessionId?: string): void {
  const f = join(stateRoot(sessionId), "cancel.json");
  if (existsSync(f)) rmSync(f);
}

// `omcp state <subcommand>` — read/write parity for mode-state files under
// `.omcp/state/<mode>-state.json`. This is a thin CLI wrapper around the same
// schema used by the typed runtime helpers in `runtime/mode-state.ts`.
//
// Session isolation: when COPILOT_SESSION_ID is set we scope reads/writes to
// `.omcp/state/sessions/<id>/`, matching the convention used by the team/loop
// subsystems.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { assertSafeSlug } from "../../runtime/safe-slug.js";

function stateRoot(): string {
  const sessionId = process.env.COPILOT_SESSION_ID;
  const base = join(process.cwd(), ".omcp", "state");
  if (sessionId && sessionId.trim().length > 0) {
    return join(base, "sessions", sessionId);
  }
  return base;
}

function modeFile(mode: string): string {
  // DD4 Lane B fix: reject path-traversal in `mode`.
  assertSafeSlug(mode, "mode");
  return join(stateRoot(), `${mode}-state.json`);
}

export interface StateListEntry {
  mode: string;
  path: string;
  active: boolean;
  size: number;
}

export function listStateFiles(): StateListEntry[] {
  const root = stateRoot();
  if (!existsSync(root)) return [];
  const out: StateListEntry[] = [];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  for (const f of entries) {
    if (!f.endsWith("-state.json")) continue;
    const p = join(root, f);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    const mode = f.replace(/-state\.json$/, "");
    let active = false;
    try {
      const body = JSON.parse(readFileSync(p, "utf8"));
      active = Boolean(body?.active);
    } catch {
      // ignore parse errors — treated as inactive
    }
    out.push({ mode, path: p, active, size: st.size });
  }
  out.sort((a, b) => a.mode.localeCompare(b.mode));
  return out;
}

export function readState(mode: string): unknown {
  const f = modeFile(mode);
  if (!existsSync(f)) return null;
  try {
    return JSON.parse(readFileSync(f, "utf8"));
  } catch (err) {
    throw new Error(
      `failed to parse state for "${mode}": ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

export function writeState(mode: string, body: unknown): string {
  const root = stateRoot();
  mkdirSync(root, { recursive: true });
  const f = modeFile(mode);
  writeFileSync(f, `${JSON.stringify(body, null, 2)}\n`, "utf8");
  return f;
}

export function clearState(mode: string): boolean {
  const f = modeFile(mode);
  if (!existsSync(f)) return false;
  rmSync(f, { force: true });
  return true;
}

export interface ClearAllReport {
  removed: string[];
}

export function clearAllState(): ClearAllReport {
  const root = stateRoot();
  const removed: string[] = [];
  if (!existsSync(root)) return { removed };
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return { removed };
  }
  for (const f of entries) {
    if (f.endsWith("-state.json") || f === "cancel.json") {
      const p = join(root, f);
      try {
        rmSync(p, { force: true });
        removed.push(p);
      } catch {
        // ignore — best-effort
      }
    }
  }
  return { removed };
}

export function formatStateList(entries: StateListEntry[]): string {
  if (entries.length === 0) return "omcp state: no state files";
  const lines = [`omcp state (${entries.length}):`];
  for (const e of entries) {
    const flag = e.active ? "active " : "       ";
    lines.push(`  ${flag} ${e.mode}  (${e.size} bytes)  ${e.path}`);
  }
  return lines.join("\n");
}

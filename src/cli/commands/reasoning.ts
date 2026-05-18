// `omcp reasoning <level>` — set the default reasoning-effort level used by
// `omcp ask`, `omcp ralph`, `omcp autopilot`, etc. when invoking copilot.
//
// Levels: low | medium | high | xhigh (matches Copilot CLI's --effort enum).
// Persists to ~/.copilot/.omcp-config.json under `reasoning.effort`.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWriteFileSync } from "../../runtime/atomic-write.js";
import { resolvePaths } from "../../runtime/paths.js";

export type ReasoningLevel = "low" | "medium" | "high" | "xhigh";
const LEVELS: ReasoningLevel[] = ["low", "medium", "high", "xhigh"];

function configFile(): string {
  const paths = resolvePaths();
  return join(paths.copilotHome, ".omcp-config.json");
}

export function readReasoning(): ReasoningLevel | undefined {
  const f = configFile();
  if (!existsSync(f)) return undefined;
  try {
    const c = JSON.parse(readFileSync(f, "utf8")) as {
      reasoning?: { effort?: ReasoningLevel };
    };
    return c.reasoning?.effort;
  } catch {
    return undefined;
  }
}

export function writeReasoning(level: ReasoningLevel): { path: string } {
  if (!LEVELS.includes(level)) {
    throw new Error(`reasoning level must be one of ${LEVELS.join("|")}`);
  }
  const f = configFile();
  mkdirSync(dirname(f), { recursive: true });
  let existing: Record<string, unknown> = {};
  if (existsSync(f)) {
    try {
      existing = JSON.parse(readFileSync(f, "utf8")) as Record<string, unknown>;
    } catch {
      existing = {};
    }
  }
  const reasoning = (existing.reasoning ?? {}) as Record<string, unknown>;
  reasoning.effort = level;
  existing.reasoning = reasoning;
  atomicWriteFileSync(f, JSON.stringify(existing, null, 2));
  return { path: f };
}

export function clearReasoning(): { path: string; cleared: boolean } {
  const f = configFile();
  if (!existsSync(f)) return { path: f, cleared: false };
  try {
    const existing = JSON.parse(readFileSync(f, "utf8")) as Record<
      string,
      unknown
    >;
    delete existing.reasoning;
    atomicWriteFileSync(f, JSON.stringify(existing, null, 2));
    return { path: f, cleared: true };
  } catch {
    return { path: f, cleared: false };
  }
}

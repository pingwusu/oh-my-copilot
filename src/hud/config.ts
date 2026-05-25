// HUD config wiring — snapshot ~/.copilot/config.json before mutation
// and wire `omcp hud` as the statusLine.command.
//
// Invariant 2: the backup write uses atomicWriteFileSync.
// Invariant 8: the statusLine.command value "omcp hud" references the
//              already-registered `omcp hud` CLI command (src/cli/omcp.ts:208).

import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

import { atomicWriteFileSync } from "../runtime/atomic-write.js";

/** The statusLine.command value omcp writes. */
export const OMCP_STATUS_LINE_COMMAND = "omcp hud";

export interface BackupResult {
  /** True when a backup was written. False when no config existed to back up. */
  backedUp: boolean;
  /** Absolute path of the backup file (present when backedUp=true). */
  backupPath: string | null;
}

/**
 * Snapshot `~/.copilot/config.json` to a timestamped backup file before
 * any mutation. Uses atomicWriteFileSync (Invariant 2).
 *
 * Returns {backedUp: false} when the config file does not exist yet (no
 * existing config = nothing to back up; proceeding is safe).
 */
export function backupCopilotConfig(copilotConfigPath: string): BackupResult {
  if (!existsSync(copilotConfigPath)) {
    return { backedUp: false, backupPath: null };
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${copilotConfigPath}.omcp-backup-${timestamp}`;

  // Read the existing config content.
  const content = readFileSync(copilotConfigPath, "utf8");

  // Invariant 2: atomicWriteFileSync for the backup.
  atomicWriteFileSync(backupPath, content);

  return { backedUp: true, backupPath };
}

export interface StatusLineWireResult {
  /** True when the statusLine was written. */
  wired: boolean;
  /** True when the config already had omcp hud wired (idempotent). */
  alreadyWired: boolean;
  /** Backup result (null when wiring was skipped). */
  backup: BackupResult | null;
}

/**
 * Wire `omcp hud` as Copilot's statusLine.command in config.json.
 *
 * Steps:
 *  1. Backup existing config (Invariant 2).
 *  2. Read existing config or start from {}.
 *  3. Merge-in statusLine.command = "omcp hud".
 *  4. Write back (plain writeFileSync — consistent with how setup.ts uses
 *     the copilot-config writeJson helper which itself uses writeFileSync).
 *
 * On any write error, attempts to restore from backup and rethrows.
 */
export function wireHudStatusLine(
  copilotConfigPath: string,
  dryRun = false,
): StatusLineWireResult {
  // Check current state.
  let existing: Record<string, unknown> = {};
  if (existsSync(copilotConfigPath)) {
    try {
      existing = JSON.parse(readFileSync(copilotConfigPath, "utf8")) as Record<string, unknown>;
    } catch {
      existing = {};
    }
  }

  const statusLine = existing.statusLine as Record<string, unknown> | undefined;
  const currentCmd = statusLine?.command as string | undefined;
  if (currentCmd === OMCP_STATUS_LINE_COMMAND) {
    return { wired: true, alreadyWired: true, backup: null };
  }

  if (dryRun) {
    return { wired: false, alreadyWired: false, backup: null };
  }

  // Backup before mutation (Invariant 2).
  const backup = backupCopilotConfig(copilotConfigPath);

  const next: Record<string, unknown> = {
    ...existing,
    statusLine: {
      ...(typeof statusLine === "object" && statusLine !== null ? statusLine : {}),
      command: OMCP_STATUS_LINE_COMMAND,
    },
  };

  try {
    writeFileSync(copilotConfigPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  } catch (err) {
    // Rollback: restore from backup if the write failed.
    if (backup.backedUp && backup.backupPath) {
      try {
        copyFileSync(backup.backupPath, copilotConfigPath);
      } catch {
        // Rollback also failed — nothing more we can do.
      }
    }
    throw err;
  }

  return { wired: true, alreadyWired: false, backup };
}

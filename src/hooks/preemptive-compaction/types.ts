/**
 * Preemptive Compaction Types
 *
 * Type definitions for monitoring context usage and triggering compaction.
 *
 * Ported from oh-my-claudecode's preemptive-compaction hook.
 * Adapted for omcp (Copilot CLI sibling).
 */

/**
 * Context usage analysis result
 */
export interface ContextUsageResult {
  /** Estimated total tokens used */
  totalTokens: number;
  /** Estimated usage ratio (0-1) */
  usageRatio: number;
  /** Whether usage is above warning threshold */
  isWarning: boolean;
  /** Whether usage is above critical threshold */
  isCritical: boolean;
  /** Suggested action */
  action: "none" | "warn" | "compact";
}

/**
 * Configuration for preemptive compaction
 */
export interface PreemptiveCompactionConfig {
  /** Enable preemptive compaction warnings */
  enabled?: boolean;
  /** Threshold ratio (0-1) to trigger warning (default: 0.85) */
  warningThreshold?: number;
  /** Threshold ratio (0-1) to trigger critical warning (default: 0.95) */
  criticalThreshold?: number;
  /** Cooldown period in ms between warnings (default: 60000) */
  cooldownMs?: number;
  /** Maximum warnings before stopping (default: 3) */
  maxWarnings?: number;
  /** Custom warning message */
  customMessage?: string;
}

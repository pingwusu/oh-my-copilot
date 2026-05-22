/**
 * Loop Detector Constants
 *
 * Thresholds for detecting repeated tool call patterns.
 */

/**
 * Default number of times a signature must appear in the window to trigger interrupt.
 */
export const DEFAULT_THRESHOLD = 5;

/**
 * Default size of the rolling window of recent tool-call signatures.
 */
export const DEFAULT_WINDOW = 10;

/**
 * Environment variable name to override the repeat threshold.
 */
export const THRESHOLD_ENV_VAR = "OMCP_LOOP_THRESHOLD";

/**
 * Environment variable name to override the rolling window size.
 */
export const WINDOW_ENV_VAR = "OMCP_LOOP_WINDOW";

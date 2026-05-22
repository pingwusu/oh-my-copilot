/**
 * Auto Recovery Advisor Constants
 */

/** Default number of recent error lines to scan for recurrence */
export const DEFAULT_WINDOW = 20;

/** Default number of times an error must repeat to trigger advice */
export const DEFAULT_RECURRENCE_THRESHOLD = 3;

/** Number of leading chars of errorMessage used as the dedup key */
export const ERROR_KEY_LENGTH = 80;

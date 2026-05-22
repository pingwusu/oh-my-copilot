/**
 * Audit Logger Constants
 *
 * File rotation and truncation limits for the append-only audit log.
 */

/**
 * Maximum size in bytes before rotating the audit log file (5 MB).
 */
export const ROTATION_BYTES = 5 * 1024 * 1024;

/**
 * Maximum characters of toolArgs JSON to store per record.
 * Excess is replaced with a truncation marker.
 */
export const MAX_ARGS_LEN = 2000;

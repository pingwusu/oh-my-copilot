/**
 * Cost Governor Constants
 *
 * Budget thresholds for tool-call counting.
 */

/**
 * Default maximum tool calls per session before interrupting.
 */
export const DEFAULT_BUDGET = 1000;

/**
 * Environment variable name to override the default budget.
 */
export const BUDGET_ENV_VAR = "OMCP_COST_BUDGET";

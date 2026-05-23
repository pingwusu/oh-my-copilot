// Escapes regex metacharacters in a user-supplied string so it can be safely
// passed to `new RegExp(...)` as a literal-match pattern.
//
// Invariant 9 (HANDOFF): user strings into `new RegExp(...)` must escape
// metachars first — otherwise `.` becomes "any char", `(` opens a group, etc.
// Use this at every CLI / MCP sink that builds a RegExp from caller input.

const REGEXP_META = /[.*+?^${}()|[\]\\]/g;

export function escapeRegExp(input: string): string {
  return input.replace(REGEXP_META, "\\$&");
}

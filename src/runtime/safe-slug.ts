// Validates mode / sessionId / wiki-slug style identifiers used as file-name
// fragments. Reject anything that could escape the intended directory.
//
// DD4 Lane B caught two path-traversal exploits — `omcp state write
// "../../pwned"` and `state_write { sessionId: "../escape" }` — because the
// CLI + MCP state servers passed the slug straight into `path.join`. This
// helper closes that hole; call it at every sink that builds a file path
// from user-supplied identifier-like strings.

const SLUG_RE = /^[A-Za-z0-9_\-.]{1,80}$/;

export class UnsafeSlugError extends Error {
  constructor(field: string, value: string) {
    super(
      `unsafe ${field}: ${JSON.stringify(value)} (allowed: A-Z a-z 0-9 _ - . , 1-80 chars, no path separators)`,
    );
    this.name = "UnsafeSlugError";
  }
}

export function assertSafeSlug(value: unknown, field = "slug"): string {
  if (typeof value !== "string") {
    throw new UnsafeSlugError(field, String(value));
  }
  if (value.length === 0 || value.length > 80) {
    throw new UnsafeSlugError(field, value);
  }
  if (value === "." || value === "..") {
    throw new UnsafeSlugError(field, value);
  }
  if (value.includes("/") || value.includes("\\")) {
    throw new UnsafeSlugError(field, value);
  }
  if (value.startsWith("-") || value.startsWith(".")) {
    // Leading dot/dash creates Unix hidden / option-like files; refuse.
    throw new UnsafeSlugError(field, value);
  }
  if (!SLUG_RE.test(value)) {
    throw new UnsafeSlugError(field, value);
  }
  return value;
}

export function isSafeSlug(value: unknown): boolean {
  try {
    assertSafeSlug(value);
    return true;
  } catch {
    return false;
  }
}

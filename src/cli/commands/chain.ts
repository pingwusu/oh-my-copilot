// `omcp ralplan --chain "<chain-spec>"` — Phase 3 chain orchestration parser.
//
// Story 8 / US-omcp-parity-P3-CHAIN-parser is the parser-only slice. The
// actual sequential runner lives in Story 9, the state-handoff in Story 10,
// preserve-P1-teamstate in Story 11, cancel-propagation in Story 12.
//
// Chain spec grammar (whitespace-tokenized, no shell-escape ambiguity since
// we pre-split on whitespace at the parser entry):
//
//   spec        := step*
//   step        := "--then" verb arg*
//   verb        := identifier
//   arg         := any-token (not "--then")
//
// Example:
//   "--then team 4 fix-typo --then ralph-verify"
//      →  [{verb:"team", args:["4","fix-typo"]}, {verb:"ralph-verify", args:[]}]
//
// Empty spec ("") → no steps → caller falls back to legacy ralplan behavior.

const THEN_MARKER = "--then";

export interface ChainStep {
  verb: string;
  args: string[];
}

export class ChainParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChainParseError";
  }
}

/**
 * Tokenize a chain spec string into raw argv-style tokens. Currently a
 * simple whitespace split — quoted-string handling is intentionally NOT
 * implemented at this layer (the surrounding shell is expected to have
 * already done quoting; if a step needs an arg with spaces, the user
 * passes the entire chain spec as a single quoted argument and the
 * shell delivers the inner string intact).
 *
 * Exported for direct unit-testing.
 */
export function tokenizeChainSpec(spec: string): string[] {
  return spec
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/**
 * Parse a tokenized chain spec into an ordered list of pipeline steps.
 *
 * Each step starts with `--then`, must be followed by at least one verb
 * token (any token that does not itself start with `--`), and may carry
 * additional positional args up to the next `--then`. An empty token
 * array yields an empty step list (legacy ralplan behavior).
 *
 * Throws ChainParseError on malformed input — e.g., a leading token that
 * is not `--then`, or a `--then` followed by another `--then` / nothing.
 *
 * Exported as the primary entry point for Story 9's runChain consumer.
 */
export function parseChainArgs(tokens: string[]): ChainStep[] {
  const steps: ChainStep[] = [];
  let i = 0;
  while (i < tokens.length) {
    const head = tokens[i];
    if (head !== THEN_MARKER) {
      throw new ChainParseError(
        `expected '${THEN_MARKER}' at position ${i}, got ${JSON.stringify(head)}`,
      );
    }
    // Step verb must be the next token, and must NOT be another --then or empty.
    const verbToken = tokens[i + 1];
    if (verbToken === undefined) {
      throw new ChainParseError(
        `'${THEN_MARKER}' at position ${i} is not followed by a verb`,
      );
    }
    if (verbToken === THEN_MARKER) {
      throw new ChainParseError(
        `'${THEN_MARKER}' at position ${i} is followed by another '${THEN_MARKER}' — missing verb`,
      );
    }
    if (verbToken.startsWith("--")) {
      throw new ChainParseError(
        `'${THEN_MARKER}' at position ${i} is followed by an option-like token ${JSON.stringify(verbToken)} — a verb is required`,
      );
    }

    const verb = verbToken;
    const args: string[] = [];
    let j = i + 2;
    while (j < tokens.length && tokens[j] !== THEN_MARKER) {
      args.push(tokens[j]);
      j++;
    }
    steps.push({ verb, args });
    i = j;
  }
  return steps;
}

/**
 * Convenience wrapper: tokenize + parse in one step. Empty / whitespace-only
 * input returns an empty step list (legacy fallback). All ChainParseError
 * propagates to the caller; CLI layer maps these to exit code 2.
 */
export function parseChainSpec(spec: string): ChainStep[] {
  return parseChainArgs(tokenizeChainSpec(spec));
}

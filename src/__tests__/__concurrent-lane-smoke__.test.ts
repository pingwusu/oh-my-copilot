/**
 * Smoke test that exercises the OMCP_RUN_HEAVY_CONCURRENCY env-var
 * gating mechanism for the v2.2 EB-06 IPC mesh concurrency lane.
 *
 * The lane (added in CI by the `test-concurrent` job in
 * `.github/workflows/ci.yml`) sets OMCP_RUN_HEAVY_CONCURRENCY=1 + runs
 * the same vitest command. Per-test `it.skipIf(!env)` gating means
 * concurrency tests skip in the default lane and run in the dedicated
 * one.
 *
 * This file exists to:
 *   1. Validate the env-var convention is observed from day one.
 *   2. Give the test-concurrent CI lane a non-zero test count even
 *      before any real 8-process test lands (Story 1 of EB-06).
 */

import { describe, expect, it } from "vitest";

const HEAVY_ON = process.env.OMCP_RUN_HEAVY_CONCURRENCY === "1";

describe("OMCP_RUN_HEAVY_CONCURRENCY env-var lane gate", () => {
  it("non-heavy lane: this assertion always holds (sanity)", () => {
    expect(1).toBe(1);
  });

  it.skipIf(!HEAVY_ON)(
    "heavy lane only: env var present + truthy",
    () => {
      expect(process.env.OMCP_RUN_HEAVY_CONCURRENCY).toBe("1");
    },
  );

  it.skipIf(HEAVY_ON)(
    "non-heavy lane only: env var absent or non-'1'",
    () => {
      // In the default lane the env should NOT be set to "1".
      expect(process.env.OMCP_RUN_HEAVY_CONCURRENCY).not.toBe("1");
    },
  );

  it("env-var-gating convention is observed (documented contract)", () => {
    // The lane contract: OMCP_RUN_HEAVY_CONCURRENCY=1 enables the
    // dedicated CI matrix entry. Other values (0, '', undefined) all
    // mean "default lane". This test asserts the convention is a
    // boolean-1 check, not a truthy-string check.
    const probe = (value: string | undefined): boolean => value === "1";
    expect(probe("1")).toBe(true);
    expect(probe("0")).toBe(false);
    expect(probe("")).toBe(false);
    expect(probe(undefined)).toBe(false);
    expect(probe("true")).toBe(false);
  });
});

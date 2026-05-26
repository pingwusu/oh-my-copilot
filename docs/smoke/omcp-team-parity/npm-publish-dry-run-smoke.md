# npm publish dry-run smoke

**Date**: 2026-05-25
**Mode**: deterministic (dry-run; no actual publish per ADR-v2.0-public-release-deferred.md)

## Environment

omcp v2.2.0. Operator-driven smoke run from `npm pack --dry-run` to verify
the tarball that would land in the public registry is structurally
correct + free of secrets. The actual `npm publish` remains
`[USER_REQUIRED]` per the v2.0 ADR.

## Pre-condition

- Working tree at HEAD (post team.ts detached-spawn fix landing).
- prepack hook runs: `npm run build && npm run sync:plugin && npm run verify:plugin-bundle`.
- All 4 manifests at v2.2.0 (Invariant 3).

## Trigger

```
npm pack --dry-run
```

This invokes the `prepack` hook which:
1. Rebuilds `dist/` from TypeScript source.
2. Syncs `plugins/oh-my-copilot/` mirror from source via `sync-plugin-mirror.ts`.
3. Runs `verify-plugin-bundle` to detect mirror drift (catches stale files
   in the mirror that no longer exist in source — surfaced during this
   smoke as 4 stale probe scripts from earlier agent diagnostic runs;
   removed before re-running pack).
4. Emits the file list + tarball metadata to stderr.

## Output

```
Tarball Details:
  name:          oh-my-copilot
  version:       2.2.0
  filename:      oh-my-copilot-2.2.0.tgz
  package size:  1.0 MB
  unpacked size: 5.8 MB
  total files:   1195
  shasum:        d2b308521677b68aa32999015635a030df8938e1
  integrity:     sha512-57k6jC+i5j9sB[...]h8rq6kE6hSfdA==
```

Secret-scan: grep for `.env`, `.secret`, `.key`, `.pem`, `.token` patterns
in the file list returns ZERO matches. No credentials or sensitive files
included in the tarball.

Stale-mirror remediation: 4 probe scripts (probe2-stale-lock.mjs,
probe3-heartbeat-race.mjs, probe4-inbox-rotation-race.mjs,
probe5-64kb-boundary.mjs) from prior agent diagnostic runs existed in
`plugins/oh-my-copilot/scripts/` but NOT in `scripts/`. The
`verify-plugin-bundle` invariant correctly blocked the pack until they
were removed from the mirror.

## Verdict

PASS — dry-run. Tarball builds, sync, mirror-verify, and secret-scan
all clean. Package size (1.0 MB compressed) is reasonable for the
multi-skill / multi-agent payload.

`npm publish` remains `[USER_REQUIRED]`: actually pushing to the public
registry requires an operator with publish credentials + acceptance of
the ADR-v2.0 deferred-public-release scope-of-acceptance. This smoke
only validates that the tarball is structurally publishable; it does
NOT replace the operator decision to publish.

## References

- docs/adr/ADR-v2.0-public-release-deferred.md
- package.json (prepack hook chain)
- src/scripts/sync-plugin-mirror.ts
- src/scripts/verify-plugin-bundle.ts

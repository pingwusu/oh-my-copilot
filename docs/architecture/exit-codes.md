# omcp CLI exit codes

| Code | Source        | Meaning                                                     |
| ---- | ------------- | ----------------------------------------------------------- |
| 0    | any           | success                                                     |
| 1    | `omcp doctor` | at least one check returned `warn`, none returned `fail`    |
| 1    | any           | uncaught exception (TypeError, ENOENT outside ~/.copilot, etc.) |
| 2    | `omcp doctor` | at least one check returned `fail`                          |
| 2    | `omcp ask`    | invalid `family` argument (not claude / gpt / auto)          |
| 2    | `omcp setup --check` *(not yet)* | drift detected (planned for M4)                |

## Subprocess pass-through

`omcp ask` returns the exit code from the underlying `copilot -p` call when
launchable (i.e., copilot exits cleanly with code 0–127). If `copilot` cannot
be spawned, the code is 1.

`omcp team` returns 0 once the workers have been dispatched; it does not block
on worker completion. Workers' own exit codes land in their per-worker log
file at `.omcp/state/sessions/<sid>/worker-N.log`.

## Doctor severity ladder

`runDoctor()` returns an array of checks; `exitCodeFor()` picks the highest
severity present:

```ts
fail   -> 2
warn   -> 1
ok     -> 0
```

Doctor is intended for both interactive use and CI gates. In CI, prefer
`omcp doctor --strict` (planned for M4) which treats `warn` as a failure.

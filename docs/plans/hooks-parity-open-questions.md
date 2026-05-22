# Open Questions

## hooks-parity v3 - 2026-05-22

### Resolved from v2 (no longer open)
- [x] ~~Does Copilot CLI consume hook stdout?~~ YES -- `additionalContext` field in hook stdout JSON is the documented injection mechanism. Already used in `src/hooks/wiki/session-hooks.ts:65,98`.
- [x] ~~What toolName does Copilot pass for /fleet dispatch?~~ RESOLVED -- `subagentStart` and `SubagentStop` are real Copilot events; no need to match toolName.
- [x] ~~Does PreSubmit include raw user prompt?~~ RESOLVED -- `UserPromptSubmit` is the real event name (not PreSubmit). Direct 1:1 mapping, same payload semantics as Claude.
- [x] ~~Does PostToolUse include error/failure status?~~ RESOLVED -- `PostToolUseFailure` is a separate dedicated event.
- [x] ~~Should we file upstream for SubagentStart/Stop/PreCompact?~~ RESOLVED -- all three already exist in Copilot CLI 1.0.48.

### Critical (blocks Phase 4/5)
- [ ] **Does Copilot CLI actually apply `modifiedArgs` from hook stdout?** -- The docs describe the field but no empirical verification yet. Must smoke-test in Phase 1 remaining work before building Phase 5. If unsupported, Phase 5 modifiedArgs applications degrade to advise-only warnings.
- [ ] **Does Copilot CLI actually apply `modifiedResult` from hook stdout?** -- Same as above. Must smoke-test before building Phase 4 hallucination shield. If unsupported, Phase 4 degrades to post-hoc factcheck (v2 behavior).
- [ ] **Does `interrupt: true` from PermissionRequest actually terminate the agent?** -- Needs empirical verification. If unsupported, cost governor and loop detector fall back to `block` (agent continues but tool denied).

### Important (affects implementation)
- [ ] What is the exact JSON schema Copilot expects for `modifiedArgs` and `modifiedResult`? -- Is it `{ modifiedArgs: {...} }` at top level of stdout JSON, or nested inside `additionalContext`? Determines `HookResult` serialization in `runtime.ts`.
- [ ] Does the `skill-injector` hook overlap with omcp's existing skill discovery? -- If redundant, skip porting.
- [ ] Should `preemptive-compaction` use token estimation or a Copilot-specific context size API? -- Affects accuracy of context overflow warnings. Now that PreCompact is a real event, we can also use it as a secondary trigger.

### Future work
- [ ] Upstream feature request to Claude Code for `modifiedArgs`/`modifiedResult` equivalents -- would enable the same supercharger patterns on both platforms.
- [ ] `HookResult` expansion from 3 to 6 variants is a breaking change for external hook authors -- document in CHANGELOG and consider semver implications.
- [ ] Re-evaluate when Copilot CLI 1.1.x ships -- may add more events or change modifiedArgs/modifiedResult protocol.

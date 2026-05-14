---
name: ultrawork
description: Parallel execution engine for high-throughput task completion
level: 4
model:
  claude: claude-sonnet-4.6
  gpt: gpt-5.2-codex
---

<Purpose>
Ultrawork is a parallel execution engine that runs multiple agents simultaneously for independent tasks. It is a component, not a standalone persistence mode -- it provides parallelism and smart model routing but not persistence, verification loops, or state management.
</Purpose>

<Use_When>
- Multiple independent tasks can run simultaneously
- User says "ulw", "ultrawork", or wants parallel execution
- You need to delegate work to multiple agents at once
- Task benefits from concurrent execution but the user will manage completion themselves
</Use_When>

<Do_Not_Use_When>
- Task requires guaranteed completion with verification -- use `ralph` instead (ralph includes ultrawork)
- Task requires a full autonomous pipeline -- use `autopilot` instead (autopilot includes ralph which includes ultrawork)
- There is only one sequential task with no parallelism opportunity -- delegate directly to an executor agent
- User needs session persistence for resume -- use `ralph` which adds persistence on top of ultrawork
</Do_Not_Use_When>

<Why_This_Exists>
Sequential task execution wastes time when tasks are independent. Ultrawork enables firing multiple agents simultaneously and routing each to the right model tier, reducing total execution time while controlling token costs. It is designed as a composable component that ralph and autopilot layer on top of.
</Why_This_Exists>

<Execution_Policy>
- Fire all independent agent calls simultaneously -- never serialize independent work
- Always pass the `model` parameter explicitly when delegating through `/fleet`
- Read `docs/shared/agent-tiers.md` before first delegation for agent selection guidance
- Use `run_in_background: true` for operations over ~30 seconds (installs, builds, tests)
- Run quick commands (git status, file reads, simple checks) in the foreground
</Execution_Policy>

<Steps>
1. **Read agent reference**: Load `docs/shared/agent-tiers.md` for tier selection
2. **Classify tasks by independence**: Identify which tasks can run in parallel vs which have dependencies
3. **Route to correct tiers**:
   - Simple lookups/definitions: LOW tier (Haiku / GPT-5-mini)
   - Standard implementation: MEDIUM tier (Sonnet / GPT-5.2-codex)
   - Complex analysis/refactoring: HIGH tier (Opus / GPT-5.4)
4. **Fire independent tasks simultaneously**: Launch all parallel-safe tasks at once through `/fleet` (local parallel dispatch) or `/delegate` (GitHub-hosted dispatch)
5. **Run dependent tasks sequentially**: Wait for prerequisites before launching dependent work
6. **Background long operations**: Builds, installs, and test suites use `run_in_background: true`
7. **Verify when all tasks complete** (lightweight):
   - Build/typecheck passes
   - Affected tests pass
   - No new errors introduced
</Steps>

<Tool_Usage>
- Dispatch a subagent through `/fleet` targeting the `executor` agent with `--model=haiku` (Claude) or `--model=gpt-5-mini` (GPT) for simple changes
- Dispatch a subagent through `/fleet` targeting `executor --model=sonnet` (Claude) or `--model=gpt-5.2-codex` (GPT) for standard work
- Dispatch a subagent through `/fleet` targeting `executor --model=opus` (Claude) or `--model=gpt-5.4` (GPT) for complex work
- Use `/delegate` instead of `/fleet` when work should be handed off to a GitHub-hosted runner rather than a local parallel worker
- Use `run_in_background: true` for package installs, builds, and test suites
- Use foreground execution for quick status checks and file operations
</Tool_Usage>

<Examples>
<Good>
Three independent tasks fired simultaneously through `/fleet`:
```
/fleet executor --model=haiku --prompt="Add missing type export for Config interface"
/fleet executor --model=sonnet --prompt="Implement the /api/users endpoint with validation"
/fleet executor --model=sonnet --prompt="Add integration tests for the auth middleware"
```
Why good: Independent tasks at appropriate tiers, all fired at once.
</Good>

<Good>
Correct use of background execution:
```
/fleet executor --model=sonnet --prompt="npm install && npm run build" --run-in-background
/fleet executor --model=haiku --prompt="Update the README with new API endpoints"
```
Why good: Long build runs in background while short task runs in foreground.
</Good>

<Bad>
Sequential execution of independent work:
```
/fleet executor "Add type export" → wait →
/fleet executor "Implement endpoint" → wait →
/fleet executor "Add tests"
```
Why bad: These tasks are independent. Running them sequentially wastes time.
</Bad>

<Bad>
Wrong tier selection:
```
/fleet executor --model=opus --prompt="Add a missing semicolon"
```
Why bad: Opus is expensive overkill for a trivial fix. Use executor with Haiku (or GPT-5-mini) instead.
</Bad>
</Examples>

<Escalation_And_Stop_Conditions>
- When ultrawork is invoked directly (not via ralph), apply lightweight verification only -- build passes, tests pass, no new errors
- For full persistence and comprehensive architect verification, recommend switching to `ralph` mode
- If a task fails repeatedly across retries, report the issue rather than retrying indefinitely
- Escalate to the user when tasks have unclear dependencies or conflicting requirements
</Escalation_And_Stop_Conditions>

<Final_Checklist>
- [ ] All parallel tasks completed
- [ ] Build/typecheck passes
- [ ] Affected tests pass
- [ ] No new errors introduced
</Final_Checklist>

<Advanced>
## Relationship to Other Modes

```
ralph (persistence wrapper)
 \-- includes: ultrawork (this skill)
     \-- provides: parallel execution only

autopilot (autonomous execution)
 \-- includes: ralph
     \-- includes: ultrawork (this skill)
```

Ultrawork is the parallelism layer. Ralph adds persistence and verification. Autopilot adds the full lifecycle pipeline.
</Advanced>

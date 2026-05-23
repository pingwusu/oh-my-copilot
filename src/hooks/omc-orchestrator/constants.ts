export const HOOK_NAME = "omc-orchestrator";

/** Path patterns (forward-slash normalized) the orchestrator may modify directly. */
export const ALLOWED_PATH_PATTERNS: RegExp[] = [
  /^\.omcp\//,     // .omcp/**
  /^\.claude\//,   // .claude/** (local)
  /CLAUDE\.md$/,   // **/CLAUDE.md
  /AGENTS\.md$/,   // **/AGENTS.md
];

/** Source file extensions that trigger delegation warnings. */
export const WARNED_EXTENSIONS: string[] = [
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".pyw",
  ".go",
  ".rs",
  ".java", ".kt", ".scala",
  ".c", ".cpp", ".cc", ".h", ".hpp",
  ".rb",
  ".php",
  ".svelte", ".vue",
  ".graphql", ".gql",
  ".sh", ".bash", ".zsh",
];

/** Tools that perform file modifications (PreToolUse + PostToolUse checks). */
export const WRITE_EDIT_TOOLS: string[] = ["Write", "Edit", "write", "edit"];

export const DIRECT_WORK_REMINDER = `

---

[SYSTEM REMINDER - DELEGATION REQUIRED]

You just performed direct file modifications outside \`.omcp/\`.

**You are an ORCHESTRATOR, not an IMPLEMENTER.**

As an orchestrator, you should:
- **DELEGATE** implementation work to subagents via the Task tool
- **VERIFY** the work done by subagents
- **COORDINATE** multiple tasks and ensure completion

You should NOT:
- Write code directly (except for \`.omcp/\` files like plans and notepads)
- Make direct file edits outside \`.omcp/\`
- Implement features yourself

**If you need to make changes:**
1. Use the Task tool to delegate to an appropriate subagent
2. Provide clear instructions in the prompt
3. Verify the subagent's work after completion

---
`;

export const ORCHESTRATOR_DELEGATION_REQUIRED = `

---

[CRITICAL SYSTEM DIRECTIVE - DELEGATION REQUIRED]

**STOP. YOU ARE VIOLATING ORCHESTRATOR PROTOCOL.**

You (coordinator) are attempting to directly modify a file outside \`.omcp/\`.

**Path attempted:** $FILE_PATH

---

**THIS IS FORBIDDEN** (except for VERIFICATION purposes)

As an ORCHESTRATOR, you MUST:
1. **DELEGATE** all implementation work via the Task tool
2. **VERIFY** the work done by subagents (reading files is OK)
3. **COORDINATE** — you orchestrate, you don't implement

**ALLOWED direct file operations:**
- Files inside \`.omcp/\` (plans, notepads, drafts)
- \`CLAUDE.md\` and \`AGENTS.md\` files
- Reading files for verification
- Running diagnostics/tests

**FORBIDDEN direct file operations:**
- Writing/editing source code
- Creating new files outside \`.omcp/\`
- Any implementation work

---

**CORRECT APPROACH:**
Task tool with subagent_type="executor"
prompt="[specific single task with clear acceptance criteria]"

DELEGATE. DON'T IMPLEMENT.

---
`;

export const BOULDER_CONTINUATION_PROMPT = `[SYSTEM REMINDER - BOULDER CONTINUATION]

You have an active work plan with incomplete tasks. Continue working.

RULES:
- Proceed without asking for permission
- Mark each checkbox [x] in the plan file when done
- Use the notepad at .omcp/notepad.md to record learnings
- Do not stop until all tasks are complete
- If blocked, document the blocker and move to the next task

Active plan: {PLAN_NAME}`;

export const VERIFICATION_REMINDER = `**MANDATORY VERIFICATION - SUBAGENTS LIE**

Subagents FREQUENTLY claim completion when:
- Tests are actually FAILING
- Code has type/lint ERRORS
- Implementation is INCOMPLETE
- Patterns were NOT followed

**YOU MUST VERIFY EVERYTHING YOURSELF:**

1. Run tests yourself — must PASS (not "agent said it passed")
2. Read the actual code — must match requirements
3. Check build/typecheck — must succeed

DO NOT TRUST THE AGENT'S SELF-REPORT.
VERIFY EACH CLAIM WITH YOUR OWN TOOL CALLS.`;

export const SINGLE_TASK_DIRECTIVE = `

[SYSTEM DIRECTIVE - SINGLE TASK ONLY]

**STOP. READ THIS BEFORE PROCEEDING.**

If you were NOT given **exactly ONE atomic task**, you MUST:
1. **IMMEDIATELY REFUSE** this request
2. **DEMAND** the orchestrator provide a single, specific task

**Your response if multiple tasks detected:**
> "I refuse to proceed. You provided multiple tasks. An orchestrator's impatience destroys work quality.
>
> PROVIDE EXACTLY ONE TASK. One file. One change. One verification.
>
> Your rushing will cause: incomplete work, missed edge cases, broken tests, wasted context."

REFUSE multi-task requests. DEMAND single-task clarity.
`;

/** Env var to set enforcement level: off | warn | strict */
export const ENFORCEMENT_LEVEL_ENV_VAR = "OMCP_ORCHESTRATOR_ENFORCEMENT";

export const DEFAULT_ENFORCEMENT_LEVEL = "warn" as const;

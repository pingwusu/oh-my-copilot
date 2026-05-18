---
name: skillify
description: Alias of /oh-my-copilot:learner — extract a learned skill from the current conversation
model:
  claude: claude-opus-4.7
  gpt: gpt-5.4
---

# Skillify (alias)

`skillify` is the omc 4.14.0 rename of the original `learner` skill. omcp keeps both names live so existing prompts continue to work.

- Canonical implementation: `/oh-my-copilot:learner`
- Triggers: `skillify`, `learn this`, `turn this into a skill`, `extract a reusable skill`

When invoked, behave exactly as `/oh-my-copilot:learner` — read its SKILL.md and follow that workflow. The contents below are kept thin on purpose so the two stay in sync; do **not** duplicate the learner workflow here.

## When to use
Use this skill when the current session uncovered a repeatable workflow that should become a reusable omcp skill, and the user (or another skill) refers to it as `skillify` rather than `learner`.

## Behavior
1. Treat invocation as an alias — defer to the learner skill's Expertise + Workflow sections.
2. If the caller seems to want the legacy `learner` interface explicitly, just hand off to `/oh-my-copilot:learner`.
3. Storage paths remain the omcp defaults:
   - User-level: `~/.copilot/skills/omcp-learned/<skill-name>.md`
   - Project-level: `.omcp/skills/<skill-name>.md`

## Related
- `/oh-my-copilot:learner` — canonical implementation
- `/oh-my-copilot:remember` — for short-lived notes instead of full skills

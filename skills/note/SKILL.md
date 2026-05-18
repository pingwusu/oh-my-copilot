---
name: note
description: Save quick notes that survive context compaction. Lighter-weight than skills; routes to omcp's project-memory + notepad MCP servers.
triggers:
  - "note"
  - "remember this"
  - "save note"
  - "scratchpad"
model:
  claude: claude-haiku-4.5
  gpt: gpt-5-mini
level: 2
---

# Note

A lightweight scratch surface for things you want to survive context compaction
but don't merit a full skill. `note` routes to three storage layers depending
on intent — pick the one that matches the note's shelf life and structure.

## Routing

| Intent                                          | Backing storage                                            | Tool call |
| ----------------------------------------------- | ---------------------------------------------------------- | --------- |
| One-line priority reminder (read by HUD)        | `.omcp/notepad.md` priority section                        | `omcp note "text"` (CLI) or `notepad_write_priority` MCP tool |
| Free-form learning from this session            | `.omcp/project-memory.json` notes array (timestamped)      | `project_memory_add_note` MCP tool |
| Binding rule for future runs                    | `.omcp/project-memory.json` directives array (timestamped) | `project_memory_add_directive` MCP tool |
| Working-set scratch (transient)                 | `.omcp/notepad.md` working section                         | `notepad_write_working` MCP tool |
| Manual user-curated section (won't auto-prune)  | `.omcp/notepad.md` manual section                          | `notepad_write_manual` MCP tool |

## When to use

- The user says "note", "remember this", "save this for later", "scratchpad"
- A learning emerged from the current task that future sessions should see
- A directive needs to be enforced going forward (e.g., "never commit secrets")
- A priority reminder should appear in the HUD line (`omcp hud` reads the first
  non-empty line of `notepad.md` priority section)

## When NOT to use

- The note is structured knowledge that benefits from indexing → use `/oh-my-copilot:wiki`
- The note is a binding rule about a specific file/area → use the existing
  `/oh-my-copilot:remember` skill which routes to AGENTS.md / CLAUDE.md edits

## Steps

1. Classify intent (priority / learning / directive / working / manual).
2. Call the matching tool on the right MCP server.
3. Confirm to user: which file got the entry, current line count.
4. If priority — also remind user the HUD will surface it next render.

## Examples

<Good>
User: `note rebuild dist before running tests after pulling main`
→ Classify: working-set scratch (transient).
→ Call `notepad_write_working` MCP tool with the text.
→ Confirm: "Appended to .omcp/notepad.md working section (3 entries)."
</Good>

<Good>
User: `note never commit .env files`
→ Classify: binding directive.
→ Call `project_memory_add_directive`.
→ Confirm: "Added to project memory directives. Future omcp sessions will see this."
</Good>

<Good>
User: `note priority: CI is failing on Windows runners`
→ Classify: priority reminder.
→ Call `notepad_write_priority`.
→ Confirm: "Pinned. HUD will show 'CI is failing on Windows runners' next render."
</Good>

## Related

- `/oh-my-copilot:remember` — review and prune accumulated project knowledge
- `/oh-my-copilot:wiki` — structured KB for things that need search + tags
- `/oh-my-copilot:learner` — extract a full skill from the current conversation

## Final checklist

- [ ] Intent classified before write (priority / learning / directive / etc.)
- [ ] Matching MCP tool invoked with the right payload
- [ ] User informed of the destination file + the entry shape
- [ ] No duplicate writes — check if a similar note already exists via `notepad_read` or `project_memory_read` first

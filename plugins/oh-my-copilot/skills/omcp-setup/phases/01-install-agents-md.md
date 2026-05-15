# Phase 1: Install AGENTS.md

## Determine Configuration Target

If `--local` flag was passed, set `CONFIG_TARGET=local`.
If `--global` flag was passed, set `CONFIG_TARGET=global`.

Otherwise (initial setup wizard), use AskUserQuestion to prompt:

**Question:** "Where should I configure oh-my-copilot?"

**Options:**
1. **Local (this project)** - Creates `.copilot/AGENTS.md` in current project directory. Best for project-specific configurations.
2. **Global (all projects)** - Creates `~/.copilot/AGENTS.md` for all Copilot CLI sessions. Best for consistent behavior everywhere.

Set `CONFIG_TARGET` to `local` or `global` based on user's choice.

## Download and Install AGENTS.md

**MANDATORY**: Always run this command. Do NOT skip. Do NOT use the Write tool. Let the setup script choose the safest canonical source (bundled `docs/AGENTS.md` first, GitHub fallback only if needed).

```bash
bash "${COPILOT_PLUGIN_ROOT}/scripts/setup-agents-md.sh" <CONFIG_TARGET>
```

Replace `<CONFIG_TARGET>` with `local` or `global`.

The script must install the canonical `docs/AGENTS.md` content and preserve the required
`<!-- OMCP:START -->` / `<!-- OMCP:END -->` markers. Do **not** hand-write, summarize, or
partially reconstruct AGENTS.md.

After running the script, verify the target file contains both markers. If marker validation
fails, stop and report the failure instead of writing AGENTS.md manually.

For `local` installs inside a git repository, the script also seeds `.git/info/exclude` with an OMCP block that ignores local `.omcp/*` artifacts by default while preserving `.omcp/skills/` for version-controlled project skills.

**FALLBACK** if curl fails:
Tell user to manually download from:
https://raw.githubusercontent.com/Yeachan-Heo/oh-my-copilot/main/docs/AGENTS.md

**Note**: The downloaded AGENTS.md includes Context Persistence instructions with `<remember>` tags for surviving conversation compaction.

**Note**: If an existing AGENTS.md is found, it will be backed up before downloading the new version.

## Report Success

If `CONFIG_TARGET` is `local`:
```
OMCP Project Configuration Complete
- AGENTS.md: Updated with latest configuration from GitHub at ./.copilot/AGENTS.md
- Git excludes: Added local `.omcp/*` ignore rules to `.git/info/exclude` (keeps `.omcp/skills/` trackable)
- Backup: Previous AGENTS.md backed up (if existed)
- Scope: PROJECT - applies only to this project
- Hooks: Provided by plugin (no manual installation needed)
- Agents: 28+ available (base + tiered variants)
- Model routing: Haiku/Sonnet/Opus based on task complexity

Note: This configuration is project-specific and won't affect other projects or global settings.
```

If `CONFIG_TARGET` is `global`:
```
OMCP Global Configuration Complete
- AGENTS.md: Updated with latest configuration from GitHub at ~/.copilot/AGENTS.md
- Backup: Previous AGENTS.md backed up (if existed)
- Scope: GLOBAL - applies to all Copilot CLI sessions
- Hooks: Provided by plugin (no manual installation needed)
- Agents: 28+ available (base + tiered variants)
- Model routing: Haiku/Sonnet/Opus based on task complexity

Note: Hooks are now managed by the plugin system automatically. No manual hook installation required.
```

## Save Progress

```bash
bash "${COPILOT_PLUGIN_ROOT}/scripts/setup-progress.sh" save 2 <CONFIG_TARGET>
```

## Early Exit for Flag Mode

If `--local` or `--global` flag was used, clear state and **STOP HERE**:
```bash
bash "${COPILOT_PLUGIN_ROOT}/scripts/setup-progress.sh" clear
```
Do not continue to Phase 2 or other phases.

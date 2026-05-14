---
name: omcp-setup
description: Install or refresh oh-my-copilot for plugin, npm, and local-dev setups from the canonical setup flow
level: 2
---

# OMCP Setup

This is the **only command you need to learn**. After running this, everything else is automatic. The Copilot CLI is reached via the `copilot` binary; the user-config dir is `~/.copilot/`. The installed plugin lives at `~/.copilot/installed-plugins/oh-my-copilot/oh-my-copilot/`.

**When this skill is invoked, immediately execute the workflow below. Do not only restate or summarize these instructions back to the user.**

Note: All `~/.copilot/...` paths in this guide respect `COPILOT_CONFIG_DIR` when that environment variable is set.

## Best-Fit Use

Choose this setup flow when the user wants to **install, refresh, or repair OMCP itself**.

- Marketplace/plugin install users should land here after `copilot plugin install oh-my-copilot` (or by running `omcp setup`)
- npm users should land here after `npm i -g oh-my-copilot@latest`
- local-dev and worktree users should land here after updating the checked-out repo and rerunning `omcp setup`

## Flag Parsing

Check for flags in the user's invocation:
- `--help` → Show Help Text (below) and stop
- `--local` → Phase 1 only (target=local), then stop
- `--global` → Phase 1 only (target=global), then stop
- `--force` → Skip Pre-Setup Check, run full setup (Phase 1 → 2 → 3 → 4)
- No flags → Run Pre-Setup Check, then full setup if needed

## Help Text

When user runs with `--help`, display this and stop:

```
OMCP Setup - Configure oh-my-copilot

USAGE:
  omcp setup                        Run initial setup wizard (or update if already configured)
  /oh-my-copilot:omcp-setup         Same, invoked from inside Copilot CLI
  /oh-my-copilot:omcp-setup --local   Configure local project (.copilot/AGENTS.md)
  /oh-my-copilot:omcp-setup --global  Configure global settings (~/.copilot/AGENTS.md)
  /oh-my-copilot:omcp-setup --force   Force full setup wizard even if already configured
  /oh-my-copilot:omcp-setup --help    Show this help

MODES:
  Initial Setup (no flags)
    - Interactive wizard for first-time setup
    - Configures AGENTS.md (local or global)
    - Sets up HUD statusline
    - Checks for updates
    - Offers MCP server configuration
    - Configures team mode defaults (agent count, type, model)
    - If already configured, offers quick update option

  Local Configuration (--local)
    - Downloads fresh AGENTS.md to ./.copilot/
    - Backs up existing AGENTS.md to .copilot/AGENTS.md.backup.YYYY-MM-DD
    - Project-specific settings
    - Use this to update project config after OMCP upgrades

  Global Configuration (--global)
    - Downloads fresh AGENTS.md to ~/.copilot/
    - Backs up existing AGENTS.md to ~/.copilot/AGENTS.md.backup.YYYY-MM-DD
    - Applies to all Copilot CLI sessions
    - Cleans up legacy hooks
    - Use this to update global config after OMCP upgrades

  Force Full Setup (--force)
    - Bypasses the "already configured" check
    - Runs the complete setup wizard from scratch
    - Use when you want to reconfigure preferences

EXAMPLES:
  omcp setup                            # First time setup (or update AGENTS.md if configured)
  /oh-my-copilot:omcp-setup --local     # Update this project
  /oh-my-copilot:omcp-setup --global    # Update all projects
  /oh-my-copilot:omcp-setup --force     # Re-run full setup wizard

For more info: https://github.com/Yeachan-Heo/oh-my-claudecode
```

## Pre-Setup Check: Already Configured?

**CRITICAL**: Before doing anything else, check if setup has already been completed. This prevents users from having to re-run the full setup wizard after every update.

```bash
# Check if setup was already completed
CONFIG_FILE="$HOME/.copilot/.omcp-config.json"

if [ -f "$CONFIG_FILE" ]; then
  SETUP_COMPLETED=$(jq -r '.setupCompleted // empty' "$CONFIG_FILE" 2>/dev/null)
  SETUP_VERSION=$(jq -r '.setupVersion // empty' "$CONFIG_FILE" 2>/dev/null)

  if [ -n "$SETUP_COMPLETED" ] && [ "$SETUP_COMPLETED" != "null" ]; then
    echo "OMCP setup was already completed on: $SETUP_COMPLETED"
    [ -n "$SETUP_VERSION" ] && echo "Setup version: $SETUP_VERSION"
    ALREADY_CONFIGURED="true"
  fi
fi
```

### If Already Configured (and no --force flag)

If `ALREADY_CONFIGURED` is true AND the user did NOT pass `--force`, `--local`, or `--global` flags:

Ask the user directly (one question at a time):

**Question:** "OMCP is already configured. What would you like to do?"

**Options:**
1. **Update AGENTS.md only** - Download latest AGENTS.md without re-running full setup
2. **Run full setup again** - Go through the complete setup wizard
3. **Cancel** - Exit without changes

**If user chooses "Update AGENTS.md only":**
- Detect if local (.copilot/AGENTS.md) or global (~/.copilot/AGENTS.md) config exists
- If local exists, run: `bash "${COPILOT_PLUGIN_ROOT}/scripts/setup-agents-md.sh" local`
- If only global exists, run: `bash "${COPILOT_PLUGIN_ROOT}/scripts/setup-agents-md.sh" global`
- Skip all other steps
- Report success and exit

**If user chooses "Run full setup again":**
- Continue with Resume Detection below

**If user chooses "Cancel":**
- Exit without any changes

### Force Flag Override

If user passes `--force` flag, skip this check and proceed directly to setup.

## Resume Detection

Before starting any phase, check for existing state:

```bash
bash "${COPILOT_PLUGIN_ROOT}/scripts/setup-progress.sh" resume
```

If state exists (output is not "fresh"), ask the user directly (one question at a time):

**Question:** "Found a previous setup session. Would you like to resume or start fresh?"

**Options:**
1. **Resume from step $LAST_STEP** - Continue where you left off
2. **Start fresh** - Begin from the beginning (clears saved state)

If user chooses "Start fresh":
```bash
bash "${COPILOT_PLUGIN_ROOT}/scripts/setup-progress.sh" clear
```

## Phase Execution

### For `--local` or `--global` flags:
Read the file at `${COPILOT_PLUGIN_ROOT}/skills/omcp-setup/phases/01-install-agents-md.md` and follow its instructions.
(The phase file handles early exit for flag mode.)

### For full setup (default or --force):
Execute phases sequentially. For each phase, read the corresponding file and follow its instructions:

1. **Phase 1 - Install AGENTS.md**: Read `${COPILOT_PLUGIN_ROOT}/skills/omcp-setup/phases/01-install-agents-md.md` and follow its instructions.

2. **Phase 2 - Environment Configuration**: Read `${COPILOT_PLUGIN_ROOT}/skills/omcp-setup/phases/02-configure.md` and follow its instructions. Phase 2 must delegate HUD/statusLine setup to the `hud` skill; do not generate or patch `statusLine` paths inline here.

3. **Phase 3 - Integration Setup**: Read `${COPILOT_PLUGIN_ROOT}/skills/omcp-setup/phases/03-integrations.md` and follow its instructions.

4. **Phase 4 - Completion**: Read `${COPILOT_PLUGIN_ROOT}/skills/omcp-setup/phases/04-welcome.md` and follow its instructions.

## Graceful Interrupt Handling

**IMPORTANT**: This setup process saves progress after each phase via `${COPILOT_PLUGIN_ROOT}/scripts/setup-progress.sh`. If interrupted (Ctrl+C or connection loss), the setup can resume from where it left off.

## Keeping Up to Date

After installing oh-my-copilot updates (via npm or plugin update):

**Automatic**: Just run `omcp setup` (or `/oh-my-copilot:omcp-setup`) - it will detect you've already configured and offer a quick "Update AGENTS.md only" option that skips the full wizard.

**Manual options**:
- `/oh-my-copilot:omcp-setup --local` to update project config only
- `/oh-my-copilot:omcp-setup --global` to update global config only
- `/oh-my-copilot:omcp-setup --force` to re-run the full wizard (reconfigure preferences)

This ensures you have the newest features and agent configurations without the token cost of repeating the full setup.

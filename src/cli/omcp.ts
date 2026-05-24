#!/usr/bin/env node
// omcp CLI entry — commander-based dispatcher.

import { Command } from "commander";
import { spawn } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runFireCli } from "../hooks/runtime.js";
import { runAsk } from "./commands/ask.js";
import { formatCleanupReport, runCleanup } from "./commands/cleanup.js";
import {
  exitCodeFor,
  formatChecks,
  runDoctor,
} from "./commands/doctor.js";
import { doctorTeamRoutingCommand } from "./commands/doctor-team-routing.js";
import { runExec } from "./commands/exec.js";
import { formatInfo, readInfo } from "./commands/info.js";
import { runLaunch } from "./commands/launch.js";
import { formatCatalog, listAgents, listSkills } from "./commands/list.js";
import { runLoop } from "./commands/loop.js";
import {
  startWatcher,
  statusWatcher,
  stopWatcher,
} from "./commands/loop-watcher.js";
import { resolveMcpServer } from "./commands/mcp-serve.js";
import { formatBoard, loadMissions } from "./commands/mission-board.js";
import { runCancel, runMode, runNote } from "./commands/mode.js";
import {
  clearReasoning,
  readReasoning,
  writeReasoning,
  type ReasoningLevel,
} from "./commands/reasoning.js";
import { formatSessions, listSessions } from "./commands/session.js";
import { runSetup } from "./commands/setup.js";
import {
  clearAllState,
  clearState,
  formatStateList,
  listStateFiles,
  readState,
  writeState,
} from "./commands/state.js";
import { runStateRalph } from "./commands/state-ralph.js";
import { runStateBoulder } from "./commands/state-boulder.js";
import { runStateTodo } from "./commands/state-todo.js";
import { runStateUltrawork } from "./commands/state-ultrawork.js";
import { formatStatus, readStatus } from "./commands/status.js";
import { parseTeamSpec, runTeam, runTeamMergeShards, runTeamWatchdog } from "./commands/team.js";
import {
  formatTeleportList,
  listTeleports,
  removeTeleport,
  runTeleport,
} from "./commands/teleport.js";
import { formatUninstallReport, runUninstall } from "./commands/uninstall.js";
import { runUpdate } from "./commands/update.js";
import { runNotepadCommand } from "./commands/notepad.js";
import { runTraceCommand } from "./commands/trace.js";
import { runProjectMemoryCommand } from "./commands/project-memory.js";
import { ultragoalCommand } from "./commands/ultragoal.js";
import { runCodeIntelCommand } from "./commands/code-intel.js";
import { runWikiCommand } from "./commands/wiki.js";
import { runVerifyPhase } from "./commands/verify-phase.js";

const MODE_COMMANDS = [
  "ralph",
  "autopilot",
  "ultrawork",
  "ultraqa",
  "sciomc",
  "plan",
  "ralplan",
  "ccg",
  "learner",
  "deep-interview",
  "deep-dive",
  "external-context",
  "ai-slop-cleaner",
  "visual-verdict",
  "autoresearch",
  "self-improve",
  "verify",
  "debug",
  "remember",
  "skillify",
] as const;

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..", "..");
const pkg = JSON.parse(
  readFileSync(resolve(packageRoot, "package.json"), "utf8"),
) as { version: string };

export async function runCli(argv: string[] = process.argv): Promise<void> {
  const program = new Command();

  program
    .name("omcp")
    .description(
      "oh-my-copilot — multi-agent orchestration layer for GitHub Copilot CLI",
    )
    .version(pkg.version);

  program
    .command("setup")
    .description("Install/refresh the omcp plugin in ~/.copilot/")
    .option("--force", "overwrite an existing install")
    .option("--dry-run", "print actions without applying")
    .action(async (opts: { force?: boolean; dryRun?: boolean }) => {
      const report = await runSetup({ ...opts, packageRoot });
      console.log(`omcp setup ${report.dryRun ? "(dry-run) " : ""}complete`);
      console.log(`  plugin      -> ${report.pluginInstalledAt}`);
      console.log(`  marketplace -> ${report.marketplaceAt}`);
      console.log(`  config.json updated: ${report.configUpdated}`);
      console.log(`  mcp-config.json updated: ${report.mcpUpdated}`);
      console.log(`  hooks auto-wired: ${report.hooksWired}`);
      console.log(`  statusLine auto-wired: ${report.statusLineWired}`);
      console.log("");
      if (report.hooksWired) {
        console.log(
          "Next: hooks auto-wired - launch `copilot` and try `/oh-my-copilot:autopilot ...`",
        );
      } else {
        console.log(
          "Next: Hooks wiring requires manual step (see docs/architecture/hooks-wiring.md)",
        );
      }
    });

  program
    .command("doctor")
    .description("Diagnose omcp install, MCP, and Copilot CLI state")
    .action(() => {
      const checks = runDoctor();
      console.log(formatChecks(checks));
      process.exitCode = exitCodeFor(checks);
    });

  program
    .command("doctor-team-routing")
    .description(
      "Full team-routing diagnostics: probe copilot/tmux on PATH + mode-state conflicts",
    )
    .option("--json", "emit JSON instead of human-readable output")
    .action(async (opts: { json?: boolean }) => {
      const code = await doctorTeamRoutingCommand({ json: opts.json });
      process.exitCode = code;
    });

  program
    .command("ask <family> <prompt>")
    .description(
      "Ask Copilot non-interactively with a chosen model family (claude|gpt|auto)",
    )
    .option("--silent", "suppress stats banner from Copilot")
    .option("--no-allow-all-tools", "do not pass --allow-all-tools")
    .option("--agent <name>", "use a specific omcp agent's recommended model")
    .action(
      (
        family: string,
        prompt: string,
        opts: {
          silent?: boolean;
          allowAllTools?: boolean;
          agent?: string;
        },
      ) => {
        const code = runAsk({
          family,
          prompt,
          silent: opts.silent,
          allowAllTools: opts.allowAllTools,
          agent: opts.agent,
          agentsDir: resolve(packageRoot, "agents"),
        });
        process.exitCode = code;
      },
    );

  program
    .command("hook")
    .description("Hook subsystem (e.g. `omcp hook fire <event>`)")
    .argument("<action>", "hook action — currently only 'fire'")
    .argument("<event>", "Hook event name (PreToolUse, PostToolUse, …)")
    .option("--json", "emit machine-readable JSON to stdout")
    .action(
      async (
        action: string,
        event: string,
        opts: { json?: boolean },
      ) => {
        if (action !== "fire") {
          console.error(`omcp hook: unknown action "${action}"`);
          process.exitCode = 2;
          return;
        }
        const code = await runFireCli({ event, json: opts.json });
        process.exitCode = code;
      },
    );

  program
    .command("hud")
    .description("Print a single-line omcp status bar (for status-line configs)")
    .option("--watch", "re-render every 2 seconds (Ctrl+C to stop)")
    .option("--interval <ms>", "watch interval in ms (default 2000)", (v) => Number(v))
    .action((opts: { watch?: boolean; interval?: number }) => {
      const hudScript = resolve(packageRoot, "scripts", "omcp-hud.mjs");
      const renderOnce = (onDone?: () => void) => {
        const child = spawn(process.execPath, [hudScript], {
          stdio: ["ignore", "inherit", "inherit"],
          env: process.env,
        });
        child.on("close", () => onDone?.());
        child.on("error", () => {
          process.stdout.write("omcp · (status unavailable)\n");
          onDone?.();
        });
      };
      if (opts.watch) {
        const interval = opts.interval ?? 2000;
        const tick = () => renderOnce();
        tick();
        const handle = setInterval(tick, interval);
        process.on("SIGINT", () => {
          clearInterval(handle);
          process.exit(0);
        });
      } else {
        renderOnce(() => {
          process.exitCode = 0;
        });
      }
    });

  program
    .command("team <spec> <task>")
    .description("Spawn a parallel team — e.g. 'omcp team 4:executor \"task\"'")
    .action((spec: string, task: string) => {
      const parsed = parseTeamSpec(spec);
      const report = runTeam(parsed, task);
      console.log(
        `omcp team launched (${report.mode}): ${report.count} worker(s)${
          report.agent ? ` as agent=${report.agent}` : ""
        }`,
      );
      console.log(`  session: ${report.sessionId}`);
      console.log(`  logs:    ${report.logDir}`);
    });

  program
    .command("team-merge-shards <team-name>")
    .description("Merge per-worker PRD shards into the canonical PRD (see omcp team)")
    .action((teamName: string) => {
      const result = runTeamMergeShards(teamName, { cwd: process.cwd() });
      if (!result.ok) {
        console.error(`omcp team-merge-shards: ${result.error}`);
        process.exitCode = 1;
        return;
      }
      const r = result.report!;
      console.log(`omcp team-merge-shards complete`);
      console.log(`  team:           ${r.teamName}`);
      console.log(`  shards merged:  ${r.shardsProcessed}`);
      console.log(`  stories updated:${r.storiesUpdated}`);
      console.log(`  conflicts:      ${r.conflicts.length}`);
    });

  program
    .command("team-watch <session-id>")
    .description("Detect stuck workers in a team session and write reassign markers")
    .option(
      "--timeout <ms>",
      "stuck threshold in ms (default: OMCP_TEAM_WATCHDOG_TIMEOUT_MS or 600000)",
      (v) => Number(v),
    )
    .action((sessionId: string, opts: { timeout?: number }) => {
      const timeoutMs =
        opts.timeout ??
        (Number(process.env.OMCP_TEAM_WATCHDOG_TIMEOUT_MS ?? "0") || undefined);
      const report = runTeamWatchdog({ sessionId, timeoutMs });
      console.log(`omcp team-watch: session=${report.sessionId}`);
      console.log(`  workers checked: ${report.workers.length}`);
      const stuck = report.workers.filter((w) => w.stuck);
      const dead = report.workers.filter((w) => w.dead);
      console.log(`  stuck:           ${stuck.length}`);
      console.log(`  dead (skipped):  ${dead.length}`);
      for (const line of report.logLines) {
        console.warn(line);
      }
      process.exitCode = stuck.length > 0 ? 1 : 0;
    });

  // ralph gets an extra --prd option for PRD-driven execution.
  program
    .command("ralph <task...>")
    .description("Run /oh-my-copilot:ralph non-interactively against Copilot")
    .option("--family <family>", "model family: claude | gpt | auto", "auto")
    .option("--agent <name>", "use a specific omcp agent's recommended model")
    .option("--silent", "suppress stats banner from Copilot")
    .option("--max-continues <n>", "cap autopilot continuation count", (v) => Number(v))
    .option("--prd <path>", "path to PRD JSON file for story-driven execution")
    .action(
      (
        taskParts: string[],
        opts: {
          family?: string;
          agent?: string;
          silent?: boolean;
          maxContinues?: number;
          prd?: string;
        },
      ) => {
        const code = runMode({
          mode: "ralph",
          task: taskParts.join(" "),
          family: opts.family as "claude" | "gpt" | "auto" | undefined,
          agent: opts.agent,
          agentsDir: resolve(packageRoot, "agents"),
          silent: opts.silent,
          maxContinues: opts.maxContinues,
          prdPath: opts.prd,
        });
        process.exitCode = code;
      },
    );

  // ralplan gets an extra --handoff option for boulder→ralph chain wiring.
  program
    .command("ralplan <task...>")
    .description("Run /oh-my-copilot:ralplan non-interactively against Copilot")
    .option("--family <family>", "model family: claude | gpt | auto", "auto")
    .option("--agent <name>", "use a specific omcp agent's recommended model")
    .option("--silent", "suppress stats banner from Copilot")
    .option("--max-continues <n>", "cap autopilot continuation count", (v) => Number(v))
    .option(
      "--handoff",
      "after ralplan exits cleanly, read boulder state and hand off to ralph (opt-in)",
    )
    .action(
      (
        taskParts: string[],
        opts: {
          family?: string;
          agent?: string;
          silent?: boolean;
          maxContinues?: number;
          handoff?: boolean;
        },
      ) => {
        const code = runMode({
          mode: "ralplan",
          task: taskParts.join(" "),
          family: opts.family as "claude" | "gpt" | "auto" | undefined,
          agent: opts.agent,
          agentsDir: resolve(packageRoot, "agents"),
          silent: opts.silent,
          maxContinues: opts.maxContinues,
          handoff: opts.handoff,
        });
        process.exitCode = code;
      },
    );

  // Mode launchers: `omcp autopilot "task"`, etc. (ralph and ralplan registered above).
  for (const mode of MODE_COMMANDS) {
    if (mode === "ralph") continue;
    if (mode === "ralplan") continue;
    program
      .command(`${mode} <task...>`)
      .description(`Run /oh-my-copilot:${mode} non-interactively against Copilot`)
      .option("--family <family>", "model family: claude | gpt | auto", "auto")
      .option("--agent <name>", "use a specific omcp agent's recommended model")
      .option("--silent", "suppress stats banner from Copilot")
      .option("--max-continues <n>", "cap autopilot continuation count", (v) => Number(v))
      .action(
        (
          taskParts: string[],
          opts: {
            family?: string;
            agent?: string;
            silent?: boolean;
            maxContinues?: number;
          },
        ) => {
          const code = runMode({
            mode,
            task: taskParts.join(" "),
            family: opts.family as "claude" | "gpt" | "auto" | undefined,
            agent: opts.agent,
            agentsDir: resolve(packageRoot, "agents"),
            silent: opts.silent,
            maxContinues: opts.maxContinues,
          });
          process.exitCode = code;
        },
      );
  }

  program
    .command("cancel")
    .description("Write a cancel marker that omcp loops/skills check on each iteration")
    .option("--reason <reason>", "free-form reason text")
    .action((opts: { reason?: string }) => {
      const report = runCancel(opts.reason);
      console.log(`omcp cancel: wrote ${report.path}`);
    });

  program
    .command("note <text...>")
    .description("Append a priority note to .omcp/notepad.md")
    .action((textParts: string[]) => {
      const report = runNote(textParts.join(" "));
      console.log(`omcp note: appended to ${report.path}`);
    });

  program
    .command("loop <interval> <cmd...>")
    .description("Re-invoke <cmd> every <interval> (e.g. 5m, 30s) until cancelled")
    .option("--max <n>", "max iterations", (v) => Number(v))
    .action(
      async (
        interval: string,
        cmd: string[],
        opts: { max?: number },
      ) => {
        const code = await runLoop({
          interval,
          cmd,
          maxIterations: opts.max,
        });
        process.exitCode = code;
      },
    );

  program
    .command("status")
    .description("Snapshot of active modes, ralph iteration, team workers, cancel state")
    .action(() => {
      const s = readStatus();
      console.log(formatStatus(s));
    });

  program
    .command("session [query]")
    .description("List omcp sessions under .omcp/state/sessions (with optional grep)")
    .action((query?: string) => {
      const sessions = listSessions(query);
      console.log(formatSessions(sessions));
    });

  program
    .command("launch")
    .description("Launch `copilot` with omcp's preferred defaults (--allow-all-tools)")
    .option("--autopilot", "pass --autopilot to copilot")
    .allowUnknownOption()
    .action((opts: { autopilot?: boolean }, command: Command) => {
      const code = runLaunch({
        args: command.args ?? [],
        autopilot: opts.autopilot,
      });
      process.exitCode = code;
    });

  program
    .command("update")
    .description("npm install -g oh-my-copilot@latest then refresh the install")
    .action(() => {
      const report = runUpdate();
      process.exitCode =
        report.npmExitCode === 0 && report.setupExitCode === 0 ? 0 : 1;
    });

  program
    .command("info")
    .description("Diagnostic dump of catalog, MCP servers, env vars, paths")
    .action(() => {
      console.log(formatInfo(readInfo(packageRoot)));
    });

  program
    .command("list [type]")
    .description("List agents / skills / all (default: all)")
    .action((type?: string) => {
      const kind = (type ?? "all").toLowerCase() as "agents" | "skills" | "all";
      if (kind === "agents") {
        console.log(formatCatalog(listAgents(packageRoot), "agents"));
      } else if (kind === "skills") {
        console.log(formatCatalog(listSkills(packageRoot), "skills"));
      } else {
        console.log(
          formatCatalog(
            [...listAgents(packageRoot), ...listSkills(packageRoot)],
            "all",
          ),
        );
      }
    });

  program
    .command("mission-board")
    .description("Render the .omcp/missions/ board view (sorted by status + priority)")
    .action(() => {
      console.log(formatBoard(loadMissions()));
    });

  program
    .command("reasoning [level]")
    .description("Get/set default reasoning effort (low|medium|high|xhigh)")
    .option("--clear", "remove the saved reasoning level")
    .action((level: string | undefined, opts: { clear?: boolean }) => {
      if (opts.clear) {
        const r = clearReasoning();
        console.log(`omcp reasoning: cleared (${r.cleared ? "yes" : "no-op"})`);
        return;
      }
      if (!level) {
        const cur = readReasoning();
        console.log(`omcp reasoning: ${cur ?? "(unset — defaults apply)"}`);
        return;
      }
      const r = writeReasoning(level as ReasoningLevel);
      console.log(`omcp reasoning: set to ${level} (${r.path})`);
    });

  program
    .command("state <action> [args...]")
    .description("State CLI: list | read <mode> | write <mode> <json> | clear <mode> | clear-all | ralph <sub> | ultrawork <sub> | todo <sub> | boulder <sub>")
    .action((action: string, args: string[]) => {
      switch (action) {
        case "list":
          console.log(formatStateList(listStateFiles()));
          return;
        case "read": {
          if (!args[0]) { console.error("omcp state read <mode>"); process.exitCode = 2; return; }
          const s = readState(args[0]);
          console.log(s === null ? "null" : JSON.stringify(s, null, 2));
          return;
        }
        case "write": {
          const [mode, json] = args;
          if (!mode || !json) { console.error("omcp state write <mode> <json>"); process.exitCode = 2; return; }
          let body: unknown;
          try { body = JSON.parse(json); }
          catch (err) { console.error(`omcp state write: invalid JSON (${(err as Error).message})`); process.exitCode = 2; return; }
          console.log(`omcp state write: ${writeState(mode, body)}`);
          return;
        }
        case "clear": {
          if (!args[0]) { console.error("omcp state clear <mode>"); process.exitCode = 2; return; }
          console.log(`omcp state clear: ${clearState(args[0]) ? "yes" : "no-op"}`);
          return;
        }
        case "clear-all": {
          const r = clearAllState();
          console.log(`omcp state clear-all: removed ${r.removed.length} file(s)`);
          return;
        }
        case "ralph": {
          process.exitCode = runStateRalph(args);
          return;
        }
        case "ultrawork": {
          process.exitCode = runStateUltrawork(args);
          return;
        }
        case "todo": {
          process.exitCode = runStateTodo(args);
          return;
        }
        case "boulder": {
          process.exitCode = runStateBoulder(args);
          return;
        }
        default:
          console.error(`omcp state: unknown action '${action}' (list|read|write|clear|clear-all|ralph|ultrawork|todo|boulder)`);
          process.exitCode = 2;
      }
    });

  program
    .command("mcp-serve <server>")
    .description("Stdio entrypoint for an omcp MCP server")
    .action((server: string) => {
      let resolved;
      try {
        resolved = resolveMcpServer(server, packageRoot);
      } catch (err) {
        console.error(`omcp mcp-serve: ${(err as Error).message}`);
        process.exitCode = 2;
        return;
      }
      const child = spawn(process.execPath, [resolved.path], { stdio: "inherit", env: process.env });
      child.on("close", (code) => { process.exitCode = code ?? 0; });
    });

  program
    .command("teleport [issueRef]")
    .description("Create a git worktree for an issue under ~/Workspace/omcp-worktrees/")
    .option("--list", "list existing teleport worktrees")
    .option("--remove <slug>", "remove a teleport worktree by slug")
    .option("--no-tmux", "skip tmux launch")
    .action((issueRef: string | undefined, opts: { list?: boolean; remove?: string; tmux?: boolean }) => {
      if (opts.list) { console.log(formatTeleportList(listTeleports())); return; }
      if (opts.remove) {
        const r = removeTeleport(opts.remove);
        console.log(r.ok
          ? `omcp teleport: removed ${opts.remove} (${r.path})`
          : `omcp teleport: remove failed — ${r.error}`);
        process.exitCode = r.ok ? 0 : 1;
        return;
      }
      if (!issueRef) {
        console.error("omcp teleport: <issueRef> is required (or pass --list / --remove <slug>)");
        process.exitCode = 2;
        return;
      }
      const result = runTeleport(issueRef, { noTmux: opts.tmux === false });
      if (!result.ok) { console.error(`omcp teleport: ${result.error ?? "failed"}`); process.exitCode = 1; return; }
      console.log(`omcp teleport: ${result.slug} -> ${result.worktreePath} (launched: ${result.launched})`);
    });

  program
    .command("loop-watcher <action>")
    .description("Manage the loop watcher daemon: start|stop|status")
    .action((action: string) => {
      const scriptPath = resolve(packageRoot, "scripts", "omcp-loop-watcher.mjs");
      switch (action) {
        case "start": { const r = startWatcher(scriptPath); console.log(`omcp loop-watcher: started (pid=${r.pid})`); return; }
        case "stop": { const r = stopWatcher(); console.log(r.stopped ? `omcp loop-watcher: stopped (pid=${r.pid})` : "omcp loop-watcher: not running"); return; }
        case "status": { const r = statusWatcher(); console.log(r.running ? `omcp loop-watcher: running (pid=${r.pid})` : "omcp loop-watcher: not running"); console.log(`  pid file: ${r.pidFile}`); console.log(`  log file: ${r.logFile}`); return; }
        default: console.error(`omcp loop-watcher: unknown action '${action}' (start|stop|status)`); process.exitCode = 2;
      }
    });

  const execCmd = program
    .command("exec <prompt>")
    .description("Run copilot -p non-interactively with omcp logging")
    .option("--model <id>", "override model")
    .option("--agent <name>", "use a specific omcp agent")
    .option("--silent", "suppress stats banner")
    .option("--no-allow-all-tools", "do not pass --allow-all-tools")
    .option("--inject <sessionId>", "resume into an existing Copilot session")
    .option("--share", "pass --share to Copilot")
    .action((prompt: string, opts: { model?: string; agent?: string; silent?: boolean; allowAllTools?: boolean; inject?: string; share?: boolean }) => {
      const r = runExec({ prompt, model: opts.model, agent: opts.agent, silent: opts.silent, allowAllTools: opts.allowAllTools, inject: opts.inject, share: opts.share });
      process.exitCode = r.exitCode;
    });

  execCmd
    .command("inject <sessionId> <prompt>")
    .description("Inject a prompt into an existing Copilot session")
    .action((sessionId: string, prompt: string) => {
      const r = runExec({ prompt, inject: sessionId });
      process.exitCode = r.exitCode;
    });

  program
    .command("uninstall")
    .description("Remove the omcp plugin from ~/.copilot/")
    .option("--purge", "also remove ~/.copilot/.omcp-config.json")
    .option("--dry-run", "preview without applying")
    .action(async (opts: { purge?: boolean; dryRun?: boolean }) => {
      const r = await runUninstall({ purge: opts.purge, dryRun: opts.dryRun });
      console.log(formatUninstallReport(r));
    });

  program
    .command("notepad <subcommand> [args...]")
    .description("Notepad CLI: read | write-priority <text> | write-working <text> | write-manual <text> | prune <section> | stats")
    .action((subcommand: string, args: string[]) => {
      runNotepadCommand([subcommand, ...args]);
    });

  program
    .command("trace <subcommand> [args...]")
    .description("Trace CLI: timeline <sessionId> [--limit=N] | summary <sessionId>")
    .action((subcommand: string, args: string[]) => {
      runTraceCommand([subcommand, ...args]);
    });

  program
    .command("project-memory <subcommand> [args...]")
    .description("Project-memory CLI: read | write <key> <value-json> | add-note <text> | add-directive <text>")
    .action((subcommand: string, args: string[]) => {
      runProjectMemoryCommand([subcommand, ...args]);
    });

  program
    .command("code-intel <subcommand> [args...]")
    .description("Code-intel CLI: lsp_diagnostics | lsp_diagnostics_directory | ast_grep_search | ast_grep_replace | lsp_* (omx parity)")
    .action(async (subcommand: string, args: string[]) => {
      await runCodeIntelCommand([subcommand, ...args]);
    });

  program
    .command("wiki <subcommand> [args...]")
    .description("Wiki CLI: ingest | query | lint | add | list | read | delete | refresh (omx parity)")
    .action((subcommand: string, args: string[]) => {
      runWikiCommand([subcommand, ...args]);
    });

  program
    .command("ultragoal <subcommand> [args...]")
    .description(
      "Durable repo-native multi-goal workflow: create-goals | complete-goals | checkpoint | status | add-goal | record-review-blockers",
    )
    .allowUnknownOption()
    .action((subcommand: string, args: string[]) => {
      ultragoalCommand([subcommand, ...args]).catch((err: unknown) => {
        console.error(err);
        process.exitCode = 1;
      });
    });

  program
    .command("verify-phase <phase-id>")
    .description(
      "Run the team+critic verification protocol for a phase (reads .omcp/state/verification/<phase-id>-submission.md)",
    )
    .option(
      "--max-iterations <n>",
      "maximum review–revise cycles before escalation (default 5)",
      (v) => Number(v),
      5,
    )
    .option(
      "--timeout <seconds>",
      "max seconds to wait per architect/critic subprocess (default 600)",
      parseFloat,
      600,
    )
    .action((phaseId: string, opts: { maxIterations?: number; timeout?: number }) => {
      const r = runVerifyPhase({ phaseId, maxIterations: opts.maxIterations, timeout: opts.timeout });
      process.exitCode = r.exitCode;
    });

  program
    .command("cleanup")
    .description("Remove orphan MCP processes, stale tmp dirs, stale session dirs")
    .option("--dry-run", "preview without deleting")
    .option("--max-age-days <n>", "stale-cutoff in days", (v) => Number(v))
    .action((opts: { dryRun?: boolean; maxAgeDays?: number }) => {
      const r = runCleanup({ dryRun: opts.dryRun, maxAgeDays: opts.maxAgeDays });
      console.log(formatCleanupReport(r));
    });

  await program.parseAsync(argv);
}

// Normalizes a filesystem path through realpathSync so that npm-link / npm-install-g
// symlinks resolve to the same canonical location as Node's ESM loader resolves
// `import.meta.url` to (which always realpath's by default). Falls back to
// `resolve` if realpathSync throws — covers the rare case where one of the paths
// doesn't actually exist on disk yet (e.g. a stale argv[1] under a renamed bin).
function canonicalize(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

export function isDirectInvocation(entry: string | undefined, here: string): boolean {
  if (!entry) return false;
  return canonicalize(entry) === canonicalize(here);
}

if (isDirectInvocation(process.argv[1], fileURLToPath(import.meta.url))) {
  runCli().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

#!/usr/bin/env node
// omcp CLI entry — commander-based dispatcher.

import { Command } from "commander";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runFireCli } from "../hooks/runtime.js";
import { runAsk } from "./commands/ask.js";
import {
  exitCodeFor,
  formatChecks,
  runDoctor,
} from "./commands/doctor.js";
import { runLaunch } from "./commands/launch.js";
import { runLoop } from "./commands/loop.js";
import { runCancel, runMode, runNote } from "./commands/mode.js";
import { formatSessions, listSessions } from "./commands/session.js";
import { runSetup } from "./commands/setup.js";
import { formatStatus, readStatus } from "./commands/status.js";
import { parseTeamSpec, runTeam } from "./commands/team.js";
import { runUpdate } from "./commands/update.js";

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
      console.log(`  plugin     -> ${report.pluginInstalledAt}`);
      console.log(`  marketplace -> ${report.marketplaceAt}`);
      console.log(`  config.json updated: ${report.configUpdated}`);
      console.log(`  mcp-config.json updated: ${report.mcpUpdated}`);
      console.log("");
      console.log("Next: launch `copilot` and try `/oh-my-copilot:autopilot ...`");
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

  // Mode launchers: `omcp ralph "task"`, `omcp autopilot "task"`, etc.
  for (const mode of MODE_COMMANDS) {
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

  await program.parseAsync(argv);
}

function isDirectInvocation(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const here = fileURLToPath(import.meta.url);
  return resolve(entry) === resolve(here);
}

if (isDirectInvocation()) {
  runCli().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

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
import { runSetup } from "./commands/setup.js";
import { parseTeamSpec, runTeam } from "./commands/team.js";

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
    .action(
      (
        family: string,
        prompt: string,
        opts: { silent?: boolean; allowAllTools?: boolean },
      ) => {
        const code = runAsk({
          family,
          prompt,
          silent: opts.silent,
          allowAllTools: opts.allowAllTools,
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
    .action(() => {
      const hudScript = resolve(packageRoot, "scripts", "omcp-hud.mjs");
      const child = spawn(process.execPath, [hudScript], {
        stdio: ["ignore", "inherit", "inherit"],
        env: process.env,
      });
      child.on("close", (code) => {
        process.exitCode = code ?? 0;
      });
      child.on("error", () => {
        process.stdout.write("omcp · (status unavailable)\n");
        process.exitCode = 0;
      });
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

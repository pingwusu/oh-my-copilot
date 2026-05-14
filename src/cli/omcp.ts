#!/usr/bin/env node
// omcp CLI entry — commander-based dispatcher.

import { Command } from "commander";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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

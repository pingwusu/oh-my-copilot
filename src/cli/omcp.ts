#!/usr/bin/env node
// omcp CLI entry — commander-based dispatcher.
// M0 ships only `version` + stubs for `setup`, `doctor`, `ask`, `team`.
// M1 fills in real behavior.

import { Command } from "commander";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(resolve(here, "..", "..", "package.json"), "utf8"),
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
    .action(async () => {
      console.log("omcp setup — M1 (not yet implemented)");
      process.exitCode = 0;
    });

  program
    .command("doctor")
    .description("Diagnose omcp install, MCP, and Copilot CLI state")
    .action(async () => {
      console.log("omcp doctor — M1 (not yet implemented)");
      process.exitCode = 0;
    });

  program
    .command("ask <family> <prompt>")
    .description("Ask Copilot non-interactively with a chosen model family (claude|gpt|auto)")
    .action(async (family: string, prompt: string) => {
      console.log(`omcp ask ${family} "${prompt}" — M1 (not yet implemented)`);
      process.exitCode = 0;
    });

  program
    .command("team <spec> <task>")
    .description("Spawn a parallel team — e.g. 'omcp team 4:executor \"task\"'")
    .action(async (spec: string, task: string) => {
      console.log(`omcp team ${spec} "${task}" — M1 (not yet implemented)`);
      process.exitCode = 0;
    });

  await program.parseAsync(argv);
}

// Direct invocation: `node dist/cli/omcp.js ...`
// Compare resolved paths instead of URLs (Windows-safe).
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

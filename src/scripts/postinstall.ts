// postinstall.ts — runs after `npm install -g oh-my-copilot` to bootstrap the
// plugin into ~/.copilot/ automatically. Mirrors omx's postinstall-bootstrap.js
// in role: removes the "manual `omcp setup`" friction.
//
// Behavior:
//   - Skip silently if running inside the source repo dev tree (we don't want
//     `npm install` in our own repo to clobber the live install)
//   - Skip if OMCP_SKIP_POSTINSTALL=1
//   - Skip if copilot CLI is not on PATH (warn once)
//   - Otherwise run `omcp setup --force` and report
//
// Wired by adding `"postinstall": "node dist/scripts/postinstall.js"` in
// package.json scripts after build.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

function inDevTree(): boolean {
  // Heuristic: if this script's grand-parent is named oh-my-copilot-r2 (or
  // contains src/cli/omcp.ts as a sibling), we're in the dev tree.
  const here = import.meta.dirname ?? __dirname;
  const repoMarker = join(here, "..", "..", "src", "cli", "omcp.ts");
  return existsSync(repoMarker);
}

function copilotOnPath(): boolean {
  const cmd = process.platform === "win32" ? "where" : "which";
  const r = spawnSync(cmd, ["copilot"], { encoding: "utf8" });
  return r.status === 0 && (r.stdout?.trim().length ?? 0) > 0;
}

function main(): void {
  if (process.env.OMCP_SKIP_POSTINSTALL === "1") {
    process.stdout.write("omcp postinstall: skipped (OMCP_SKIP_POSTINSTALL=1)\n");
    return;
  }
  if (inDevTree()) {
    process.stdout.write("omcp postinstall: skipped (dev tree detected)\n");
    return;
  }
  if (!copilotOnPath()) {
    process.stdout.write(
      "omcp postinstall: copilot CLI not on PATH; run `omcp setup` manually after installing copilot\n",
    );
    return;
  }

  // Invoke `node <here>/../cli/omcp.js setup --force` directly rather than
  // the `omcp` shim — global npm bin may not be on PATH yet when postinstall
  // fires (DD4 Lane C P1).
  const here = import.meta.dirname ?? __dirname;
  const cliPath = join(here, "..", "cli", "omcp.js");
  process.stdout.write(
    `omcp postinstall: running \`node ${cliPath} setup --force\`...\n`,
  );
  const r = spawnSync(process.execPath, [cliPath, "setup", "--force"], {
    stdio: "inherit",
  });
  if ((r.status ?? 1) === 0) {
    process.stdout.write("omcp postinstall: complete\n");
  } else {
    process.stderr.write(
      `omcp postinstall: setup exited ${r.status}; run \`omcp setup\` manually to retry\n`,
    );
  }
}

const isMain =
  process.argv[1] && process.argv[1].endsWith("postinstall.js");
if (isMain) main();

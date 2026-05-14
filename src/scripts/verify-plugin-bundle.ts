// verify-plugin-bundle.ts — assert plugins/oh-my-copilot/ mirror is in sync
// with the repo-root source-of-truth.
//
// Run as part of `npm run prepack`.

import { sync } from "./sync-plugin-mirror.js";

function main() {
  const drift = sync({ check: true });
  const total = drift.added.length + drift.removed.length + drift.changed.length;
  if (total === 0) {
    console.log("verify-plugin-bundle: plugins/oh-my-copilot/ in sync");
    return;
  }
  console.error("verify-plugin-bundle: mirror is out of sync. Run `npx tsx src/scripts/sync-plugin-mirror.ts`");
  for (const a of drift.added) console.error(`  + ${a}`);
  for (const r of drift.removed) console.error(`  - ${r}`);
  for (const c of drift.changed) console.error(`  ~ ${c}`);
  process.exit(1);
}

const isMain =
  process.argv[1] && process.argv[1].endsWith("verify-plugin-bundle.js");
if (isMain) main();

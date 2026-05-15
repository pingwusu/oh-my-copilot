// `omcp ask <family> <prompt>` — one-shot non-interactive question via copilot -p.
// `family` is claude | gpt | auto; resolved into a concrete model id (per-agent
// override when --agent is supplied) and passed to copilot via --model.

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import {
  loadAgentCatalog,
  resolveAgentModel,
} from "../../runtime/agent-models.js";
import {
  type DualModel,
  type ModelFamily,
  pickModel,
  resolveFamily,
} from "../../runtime/model-routing.js";

export interface AskOptions {
  family: string;
  prompt: string;
  agent?: string;
  agentsDir?: string;
  allowAllTools?: boolean;
  silent?: boolean;
  defaults?: DualModel;
}

const DEFAULT_DUAL: DualModel = {
  claude: "claude-sonnet-4.6",
  gpt: "gpt-5.2",
};

export function runAsk(opts: AskOptions): number {
  const familyArg = opts.family as ModelFamily | "auto";
  if (familyArg !== "claude" && familyArg !== "gpt" && familyArg !== "auto") {
    console.error(
      `omcp ask: family must be one of claude | gpt | auto (got: ${opts.family})`,
    );
    return 2;
  }

  let model: string;
  if (opts.agent) {
    const agentsDir =
      opts.agentsDir ?? join(process.cwd(), "agents");
    const catalog = loadAgentCatalog(agentsDir);
    const resolved = resolveAgentModel({
      agent: opts.agent,
      override: familyArg,
      env: process.env,
      catalog,
      fallback: opts.defaults ?? DEFAULT_DUAL,
    });
    model = resolved.model;
  } else {
    const resolvedFamily = resolveFamily(familyArg, process.env, undefined);
    model = pickModel(opts.defaults ?? DEFAULT_DUAL, resolvedFamily);
  }

  const args = ["-p", opts.prompt, "--model", model];
  if (opts.agent) args.push("--agent", opts.agent);
  if (opts.allowAllTools !== false) args.push("--allow-all-tools");
  if (opts.silent) args.push("-s");

  const result = spawnSync("copilot", args, { stdio: "inherit", shell: false });
  return result.status ?? 1;
}

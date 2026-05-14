// `omcp ask <family> <prompt>` — one-shot non-interactive question via copilot -p.
// `family` is claude | gpt | auto; resolved into a concrete model id and passed
// to copilot via --model.

import { spawnSync } from "node:child_process";
import {
  type DualModel,
  type ModelFamily,
  pickModel,
  resolveFamily,
} from "../../runtime/model-routing.js";

export interface AskOptions {
  family: string;
  prompt: string;
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
  const resolved = resolveFamily(familyArg, process.env, undefined);
  const model = pickModel(opts.defaults ?? DEFAULT_DUAL, resolved);

  const args = ["-p", opts.prompt, "--model", model];
  if (opts.allowAllTools !== false) args.push("--allow-all-tools");
  if (opts.silent) args.push("-s");

  const result = spawnSync("copilot", args, { stdio: "inherit", shell: false });
  return result.status ?? 1;
}

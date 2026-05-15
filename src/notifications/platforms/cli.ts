// CLI transport — execute a configured command with templated args.
// Uses spawnSync (synchronous, with timeout) and reports stdout/stderr on
// non-zero exit.

import { spawnSync } from "node:child_process";
import type { CliIntegrationConfig, NotifyContext, SendResult } from "../types.js";
import { renderTemplate } from "../template.js";

export function sendCli(
  cfg: CliIntegrationConfig,
  ctx: NotifyContext,
): SendResult {
  if (!cfg.command || cfg.command.trim().length === 0) {
    return { ok: false, status: 0, error: "cli: missing command" };
  }
  const args = (cfg.args ?? []).map((a) => renderTemplate(a, ctx));
  const env = { ...process.env, ...(cfg.env ?? {}) };
  const timeoutMs = typeof cfg.timeout === "number" && cfg.timeout > 0 ? cfg.timeout : 5_000;

  try {
    const result = spawnSync(cfg.command, args, {
      env,
      timeout: timeoutMs,
      encoding: "utf8",
      shell: false,
    });
    if (result.error) {
      return { ok: false, status: result.status ?? 0, error: `cli: ${result.error.message}` };
    }
    const code = result.status ?? 0;
    if (code === 0) return { ok: true, status: 0 };
    const stderr = (result.stderr ?? "").trim();
    return {
      ok: false,
      status: code,
      error: stderr ? `cli: exit ${code}: ${stderr}` : `cli: exit ${code}`,
    };
  } catch (err) {
    return { ok: false, status: 0, error: `cli: ${(err as Error).message}` };
  }
}

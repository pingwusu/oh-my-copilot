// Slack incoming-webhook transport.

import type { SendResult, SlackConfig } from "../types.js";

export async function sendSlack(
  cfg: SlackConfig,
  text: string,
): Promise<SendResult> {
  if (!cfg.webhookUrl) {
    return { ok: false, status: 0, error: "slack: missing webhookUrl" };
  }
  const payload: Record<string, unknown> = { text };
  if (cfg.username) payload.username = cfg.username;
  if (cfg.channel) payload.channel = cfg.channel;

  try {
    const res = await fetch(cfg.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.ok) return { ok: true, status: res.status };
    const detail = await res.text().catch(() => "");
    return {
      ok: false,
      status: res.status,
      error: detail
        ? `slack: HTTP ${res.status} ${detail}`
        : `slack: HTTP ${res.status}`,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: `slack: ${(err as Error).message}`,
    };
  }
}

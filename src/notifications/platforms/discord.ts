// Discord transports — incoming webhook and bot REST API.
// Native fetch only.

import type { DiscordBotConfig, DiscordWebhookConfig, SendResult } from "../types.js";

export async function sendDiscordWebhook(
  cfg: DiscordWebhookConfig,
  text: string,
): Promise<SendResult> {
  if (!cfg.webhookUrl) {
    return { ok: false, status: 0, error: "discord: missing webhookUrl" };
  }
  const payload: Record<string, unknown> = { content: text };
  if (cfg.username) payload.username = cfg.username;

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
        ? `discord-webhook: HTTP ${res.status} ${detail}`
        : `discord-webhook: HTTP ${res.status}`,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: `discord-webhook: ${(err as Error).message}`,
    };
  }
}

export async function sendDiscordBot(
  cfg: DiscordBotConfig,
  text: string,
): Promise<SendResult> {
  if (!cfg.botToken || !cfg.channelId) {
    return { ok: false, status: 0, error: "discord-bot: missing botToken or channelId" };
  }
  const url = `https://discord.com/api/v10/channels/${cfg.channelId}/messages`;
  const payload: Record<string, unknown> = { content: text };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bot ${cfg.botToken}`,
      },
      body: JSON.stringify(payload),
    });
    if (res.ok) return { ok: true, status: res.status };
    const detail = await res.text().catch(() => "");
    return {
      ok: false,
      status: res.status,
      error: detail
        ? `discord-bot: HTTP ${res.status} ${detail}`
        : `discord-bot: HTTP ${res.status}`,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: `discord-bot: ${(err as Error).message}`,
    };
  }
}

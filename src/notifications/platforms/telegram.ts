// Telegram sendMessage transport.
// Uses Node 20+ native fetch — no axios dependency.

import type { SendResult, TelegramConfig } from "../types.js";

export async function sendTelegram(
  cfg: TelegramConfig,
  text: string,
): Promise<SendResult> {
  if (!cfg.botToken || !cfg.chatId) {
    return { ok: false, status: 0, error: "telegram: missing botToken or chatId" };
  }
  const url = `https://api.telegram.org/bot${cfg.botToken}/sendMessage`;
  const body: Record<string, unknown> = {
    chat_id: cfg.chatId,
    text,
  };
  if (cfg.parseMode) body.parse_mode = cfg.parseMode;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) return { ok: true, status: res.status };
    let detail = "";
    try {
      const data = (await res.json()) as { description?: string };
      detail = data?.description ?? "";
    } catch {
      detail = await res.text().catch(() => "");
    }
    return {
      ok: false,
      status: res.status,
      error: detail ? `telegram: ${detail}` : `telegram: HTTP ${res.status}`,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: `telegram: ${(err as Error).message}`,
    };
  }
}

// Load ~/.copilot/.omcp-config.json and merge in env-var overrides.
//
// Env vars win for credentials (tokens, URLs) so headless deployments can
// configure platforms without touching the JSON file. Activation flags
// (OMCP_TELEGRAM=1, etc.) are NOT used here — those gate the dispatcher,
// not the config shape.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  DiscordBotConfig,
  DiscordWebhookConfig,
  NotifyConfig,
  SlackConfig,
  TelegramConfig,
} from "./types.js";

export function resolveConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.OMCP_HOME ?? join(homedir(), ".copilot");
  return join(home, ".omcp-config.json");
}

function readJson(path: string): NotifyConfig {
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path, "utf8");
    if (!raw.trim()) return {};
    return JSON.parse(raw) as NotifyConfig;
  } catch {
    return {};
  }
}

function applyTelegramEnv(
  current: TelegramConfig | undefined,
  env: NodeJS.ProcessEnv,
): TelegramConfig | undefined {
  const token = env.OMCP_TELEGRAM_BOT_TOKEN;
  const chatId = env.OMCP_TELEGRAM_CHAT_ID;
  const parseMode = env.OMCP_TELEGRAM_PARSE_MODE as TelegramConfig["parseMode"] | undefined;
  if (!current && !(token && chatId)) return current;
  const base: TelegramConfig = current ?? { botToken: "", chatId: "" };
  return {
    ...base,
    botToken: token ?? base.botToken,
    chatId: chatId ?? base.chatId,
    parseMode: parseMode ?? base.parseMode,
    enabled: base.enabled ?? true,
  };
}

function applyDiscordEnv(
  current: DiscordWebhookConfig | undefined,
  env: NodeJS.ProcessEnv,
): DiscordWebhookConfig | undefined {
  const url = env.OMCP_DISCORD_WEBHOOK_URL;
  const mention = env.OMCP_DISCORD_MENTION;
  const username = env.OMCP_DISCORD_USERNAME;
  if (!current && !url) return current;
  const base: DiscordWebhookConfig = current ?? { webhookUrl: "" };
  return {
    ...base,
    webhookUrl: url ?? base.webhookUrl,
    mention: mention ?? base.mention,
    username: username ?? base.username,
    enabled: base.enabled ?? true,
  };
}

function applyDiscordBotEnv(
  current: DiscordBotConfig | undefined,
  env: NodeJS.ProcessEnv,
): DiscordBotConfig | undefined {
  const token = env.OMCP_DISCORD_NOTIFIER_BOT_TOKEN;
  const channelId = env.OMCP_DISCORD_NOTIFIER_CHANNEL;
  const mention = env.OMCP_DISCORD_MENTION;
  if (!current && !(token && channelId)) return current;
  const base: DiscordBotConfig = current ?? { botToken: "", channelId: "" };
  return {
    ...base,
    botToken: token ?? base.botToken,
    channelId: channelId ?? base.channelId,
    mention: mention ?? base.mention,
    enabled: base.enabled ?? true,
  };
}

function applySlackEnv(
  current: SlackConfig | undefined,
  env: NodeJS.ProcessEnv,
): SlackConfig | undefined {
  const url = env.OMCP_SLACK_WEBHOOK_URL;
  const mention = env.OMCP_SLACK_MENTION;
  const channel = env.OMCP_SLACK_CHANNEL;
  const username = env.OMCP_SLACK_USERNAME;
  if (!current && !url) return current;
  const base: SlackConfig = current ?? { webhookUrl: "" };
  return {
    ...base,
    webhookUrl: url ?? base.webhookUrl,
    mention: mention ?? base.mention,
    channel: channel ?? base.channel,
    username: username ?? base.username,
    enabled: base.enabled ?? true,
  };
}

export interface LoadOptions {
  env?: NodeJS.ProcessEnv;
  path?: string;
}

export function loadConfig(options: LoadOptions = {}): NotifyConfig {
  const env = options.env ?? process.env;
  const path = options.path ?? resolveConfigPath(env);
  const fileConfig = readJson(path);

  const merged: NotifyConfig = {
    ...fileConfig,
    notifications: {
      ...(fileConfig.notifications ?? {}),
    },
  };
  const notif = merged.notifications!;

  const tg = applyTelegramEnv(notif.telegram, env);
  if (tg) notif.telegram = tg;

  const dc = applyDiscordEnv(notif.discord, env);
  if (dc) notif.discord = dc;

  const dbot = applyDiscordBotEnv(notif["discord-bot"], env);
  if (dbot) notif["discord-bot"] = dbot;

  const sl = applySlackEnv(notif.slack, env);
  if (sl) notif.slack = sl;

  // If notifications.enabled is undefined but any platform is configured, default to true.
  if (notif.enabled === undefined) {
    if (notif.telegram || notif.discord || notif["discord-bot"] || notif.slack) {
      notif.enabled = true;
    }
  }

  return merged;
}

// Top-level notification dispatcher.
//
// Given an event + context + loaded config, fire every platform that is:
//   1. Configured AND enabled in the config
//   2. Activated via its env-var flag (OMCP_TELEGRAM=1, OMCP_DISCORD=1, ...)
//   3. Not opted out of this specific event
//
// Template resolution order, most specific first:
//   1. platform.events[event].template
//   2. config.notifications.events[event].template  (global event template)
//   3. platform.template                            (platform default)
//   4. built-in DEFAULT_TEMPLATES[event]
//
// Errors from individual platforms are isolated — one failure does not abort
// the rest.

import type {
  DispatchReport,
  DispatchResult,
  NotifyConfig,
  NotifyContext,
  NotifyEvent,
  PlatformBase,
} from "./types.js";
import { renderTemplate } from "./template.js";
import { sendTelegram } from "./platforms/telegram.js";
import { sendDiscordWebhook, sendDiscordBot } from "./platforms/discord.js";
import { sendSlack } from "./platforms/slack.js";
import { sendGenericWebhook } from "./platforms/webhook.js";
import { sendCli } from "./platforms/cli.js";

export const DEFAULT_TEMPLATES: Record<NotifyEvent, string> = {
  "session-end":
    "Session ended: {{projectDisplay}} ({{duration}}) — {{reasonDisplay}}\n{{footer}}",
  "ask-user-question":
    "Input needed on {{projectDisplay}}: {{question}}\n{{footer}}",
  "session-start":
    "Session started: {{projectDisplay}} at {{time}}\n{{footer}}",
  "session-idle":
    "{{projectDisplay}} is idle.{{#if reason}} Reason: {{reason}}{{/if}}\n{{footer}}",
  "session-continuing":
    "{{projectDisplay}} session continuing — iteration {{iterationDisplay}}\n{{footer}}",
};

function isActivated(flag: string | undefined, env: NodeJS.ProcessEnv): boolean {
  if (!flag) return false;
  const v = env[flag];
  return v === "1" || v === "true" || v === "yes";
}

function isEventEnabled(
  event: NotifyEvent,
  platform: PlatformBase | undefined,
  config: NotifyConfig,
): boolean {
  // Platform-event explicit toggle wins.
  const platformEvt = platform?.events?.[event];
  if (platformEvt?.enabled === false) return false;
  if (platformEvt?.enabled === true) return true;
  // Then global event toggle.
  const globalEvt = config.notifications?.events?.[event];
  if (globalEvt?.enabled === false) return false;
  return true;
}

function resolveTemplate(
  event: NotifyEvent,
  platform: PlatformBase | undefined,
  config: NotifyConfig,
): string {
  const platformEvtTpl = platform?.events?.[event]?.template;
  if (typeof platformEvtTpl === "string" && platformEvtTpl.length > 0) return platformEvtTpl;
  const globalEvtTpl = config.notifications?.events?.[event]?.template;
  if (typeof globalEvtTpl === "string" && globalEvtTpl.length > 0) return globalEvtTpl;
  if (typeof platform?.template === "string" && platform.template.length > 0) return platform.template;
  return DEFAULT_TEMPLATES[event];
}

export interface DispatchOptions {
  env?: NodeJS.ProcessEnv;
}

export async function dispatch(
  event: NotifyEvent,
  ctx: NotifyContext,
  config: NotifyConfig,
  options: DispatchOptions = {},
): Promise<DispatchReport> {
  const env = options.env ?? process.env;
  const results: DispatchResult[] = [];
  const fullCtx: NotifyContext = { ...ctx, event };

  const notif = config.notifications;
  const globalEnabled = notif?.enabled !== false;

  // ---- Telegram ----
  if (notif?.telegram && globalEnabled) {
    const cfg = notif.telegram;
    if (cfg.enabled === false) {
      results.push({ platform: "telegram", ok: false, skipped: true, reason: "disabled" });
    } else if (!isActivated("OMCP_TELEGRAM", env)) {
      results.push({ platform: "telegram", ok: false, skipped: true, reason: "not-activated" });
    } else if (!isEventEnabled(event, cfg, config)) {
      results.push({ platform: "telegram", ok: false, skipped: true, reason: "event-disabled" });
    } else {
      const text = renderTemplate(resolveTemplate(event, cfg, config), fullCtx);
      try {
        const r = await sendTelegram(cfg, text);
        results.push({ platform: "telegram", ok: r.ok, status: r.status, error: r.error });
      } catch (err) {
        results.push({ platform: "telegram", ok: false, error: (err as Error).message });
      }
    }
  }

  // ---- Discord webhook ----
  if (notif?.discord && globalEnabled) {
    const cfg = notif.discord;
    if (cfg.enabled === false) {
      results.push({ platform: "discord", ok: false, skipped: true, reason: "disabled" });
    } else if (!isActivated("OMCP_DISCORD", env)) {
      results.push({ platform: "discord", ok: false, skipped: true, reason: "not-activated" });
    } else if (!isEventEnabled(event, cfg, config)) {
      results.push({ platform: "discord", ok: false, skipped: true, reason: "event-disabled" });
    } else {
      let text = renderTemplate(resolveTemplate(event, cfg, config), fullCtx);
      if (cfg.mention) text = `${cfg.mention}\n${text}`;
      try {
        const r = await sendDiscordWebhook(cfg, text);
        results.push({ platform: "discord", ok: r.ok, status: r.status, error: r.error });
      } catch (err) {
        results.push({ platform: "discord", ok: false, error: (err as Error).message });
      }
    }
  }

  // ---- Discord bot ----
  const dbot = notif?.["discord-bot"];
  if (dbot && globalEnabled) {
    if (dbot.enabled === false) {
      results.push({ platform: "discord-bot", ok: false, skipped: true, reason: "disabled" });
    } else if (!isActivated("OMCP_DISCORD", env)) {
      results.push({ platform: "discord-bot", ok: false, skipped: true, reason: "not-activated" });
    } else if (!isEventEnabled(event, dbot, config)) {
      results.push({ platform: "discord-bot", ok: false, skipped: true, reason: "event-disabled" });
    } else {
      let text = renderTemplate(resolveTemplate(event, dbot, config), fullCtx);
      if (dbot.mention) text = `${dbot.mention}\n${text}`;
      try {
        const r = await sendDiscordBot(dbot, text);
        results.push({ platform: "discord-bot", ok: r.ok, status: r.status, error: r.error });
      } catch (err) {
        results.push({ platform: "discord-bot", ok: false, error: (err as Error).message });
      }
    }
  }

  // ---- Slack ----
  if (notif?.slack && globalEnabled) {
    const cfg = notif.slack;
    if (cfg.enabled === false) {
      results.push({ platform: "slack", ok: false, skipped: true, reason: "disabled" });
    } else if (!isActivated("OMCP_SLACK", env)) {
      results.push({ platform: "slack", ok: false, skipped: true, reason: "not-activated" });
    } else if (!isEventEnabled(event, cfg, config)) {
      results.push({ platform: "slack", ok: false, skipped: true, reason: "event-disabled" });
    } else {
      let text = renderTemplate(resolveTemplate(event, cfg, config), fullCtx);
      if (cfg.mention) text = `${cfg.mention}\n${text}`;
      try {
        const r = await sendSlack(cfg, text);
        results.push({ platform: "slack", ok: r.ok, status: r.status, error: r.error });
      } catch (err) {
        results.push({ platform: "slack", ok: false, error: (err as Error).message });
      }
    }
  }

  // ---- Custom integrations (webhook / cli) ----
  const customs = config.customIntegrations;
  if (customs?.enabled !== false && customs?.integrations?.length) {
    const webhookActivated = isActivated("OMCP_WEBHOOK", env);
    for (const integration of customs.integrations) {
      const id = integration.id;
      if (integration.enabled === false) {
        results.push({ platform: id, ok: false, skipped: true, reason: "disabled" });
        continue;
      }
      if (integration.events && !integration.events.includes(event)) {
        results.push({ platform: id, ok: false, skipped: true, reason: "event-not-listed" });
        continue;
      }
      // Allow per-preset activation: openclaw -> OMCP_OPENCLAW
      const presetFlag =
        integration.preset === "openclaw"
          ? "OMCP_OPENCLAW"
          : undefined;
      const activated = (presetFlag && isActivated(presetFlag, env)) || webhookActivated;
      if (!activated) {
        results.push({ platform: id, ok: false, skipped: true, reason: "not-activated" });
        continue;
      }

      try {
        if (integration.type === "cli") {
          const r = sendCli(integration.config as never, fullCtx);
          results.push({ platform: id, ok: r.ok, status: r.status, error: r.error });
        } else {
          const r = await sendGenericWebhook(integration.config as never, fullCtx);
          results.push({ platform: id, ok: r.ok, status: r.status, error: r.error });
        }
      } catch (err) {
        results.push({ platform: id, ok: false, error: (err as Error).message });
      }
    }
  }

  return { event, results };
}

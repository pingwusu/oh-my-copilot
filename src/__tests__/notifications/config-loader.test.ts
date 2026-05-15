import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import { loadConfig, resolveConfigPath } from "../../notifications/config-loader.js";

describe("config-loader", () => {
  let home: string;
  let configFile: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "omcp-notif-"));
    mkdirSync(home, { recursive: true });
    configFile = join(home, ".omcp-config.json");
  });

  it("resolves config path from OMCP_HOME", () => {
    const p = resolveConfigPath({ OMCP_HOME: "/tmp/home" });
    expect(p).toContain(".omcp-config.json");
    expect(p).toContain("home");
  });

  it("returns empty config when file is missing", () => {
    const cfg = loadConfig({ env: { OMCP_HOME: home } });
    expect(cfg.notifications ?? {}).toEqual({});
  });

  it("loads file config and merges in env-var overrides (env wins)", () => {
    writeFileSync(
      configFile,
      JSON.stringify({
        notifications: {
          enabled: true,
          telegram: { botToken: "FILE_TOKEN", chatId: "FILE_CHAT", enabled: true },
        },
      }),
      "utf8",
    );
    const cfg = loadConfig({
      env: {
        OMCP_HOME: home,
        OMCP_TELEGRAM_BOT_TOKEN: "ENV_TOKEN",
        // chat id not overridden -> retains file value
      },
    });
    expect(cfg.notifications!.telegram!.botToken).toBe("ENV_TOKEN");
    expect(cfg.notifications!.telegram!.chatId).toBe("FILE_CHAT");
  });

  it("builds telegram config purely from env vars when file omits it", () => {
    writeFileSync(configFile, JSON.stringify({ notifications: {} }), "utf8");
    const cfg = loadConfig({
      env: {
        OMCP_HOME: home,
        OMCP_TELEGRAM_BOT_TOKEN: "T",
        OMCP_TELEGRAM_CHAT_ID: "C",
      },
    });
    expect(cfg.notifications!.telegram!.botToken).toBe("T");
    expect(cfg.notifications!.telegram!.chatId).toBe("C");
    expect(cfg.notifications!.telegram!.enabled).toBe(true);
  });

  it("supports discord and slack env overrides", () => {
    const cfg = loadConfig({
      env: {
        OMCP_HOME: home,
        OMCP_DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/x/y",
        OMCP_SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/A/B/C",
      },
    });
    expect(cfg.notifications!.discord!.webhookUrl).toBe(
      "https://discord.com/api/webhooks/x/y",
    );
    expect(cfg.notifications!.slack!.webhookUrl).toBe(
      "https://hooks.slack.com/services/A/B/C",
    );
  });
});

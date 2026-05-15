import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { sendTelegram } from "../../notifications/platforms/telegram.js";
import {
  sendDiscordBot,
  sendDiscordWebhook,
} from "../../notifications/platforms/discord.js";
import { sendSlack } from "../../notifications/platforms/slack.js";
import { sendGenericWebhook } from "../../notifications/platforms/webhook.js";

function okResponse(): Response {
  return new Response("{}", {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("platform send functions", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(okResponse() as never);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("sendTelegram POSTs to correct URL with chat_id, text, parse_mode", async () => {
    const r = await sendTelegram(
      { botToken: "TOK", chatId: "42", parseMode: "HTML" },
      "hello",
    );
    expect(r.ok).toBe(true);
    expect(r.status).toBe(200);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.telegram.org/botTOK/sendMessage");
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ chat_id: "42", text: "hello", parse_mode: "HTML" });
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("sendTelegram surfaces error description on HTTP failure", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ description: "chat not found" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }) as never,
    );
    const r = await sendTelegram({ botToken: "X", chatId: "Y" }, "t");
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
    expect(r.error).toContain("chat not found");
  });

  it("sendDiscordWebhook POSTs to webhook URL with content+username", async () => {
    const r = await sendDiscordWebhook(
      { webhookUrl: "https://discord.com/api/webhooks/1/abc", username: "Bot" },
      "msg",
    );
    expect(r.ok).toBe(true);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://discord.com/api/webhooks/1/abc");
    expect(JSON.parse(init.body as string)).toEqual({
      content: "msg",
      username: "Bot",
    });
  });

  it("sendDiscordBot sets Authorization Bot header and channel URL", async () => {
    const r = await sendDiscordBot(
      { botToken: "BOTTOK", channelId: "CHAN9" },
      "yo",
    );
    expect(r.ok).toBe(true);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://discord.com/api/v10/channels/CHAN9/messages");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bot BOTTOK");
    expect(JSON.parse(init.body as string)).toEqual({ content: "yo" });
  });

  it("sendSlack POSTs to webhookUrl with text/channel/username", async () => {
    const r = await sendSlack(
      {
        webhookUrl: "https://hooks.slack.com/services/A/B/C",
        channel: "#x",
        username: "OMCP",
      },
      "ping",
    );
    expect(r.ok).toBe(true);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://hooks.slack.com/services/A/B/C");
    expect(JSON.parse(init.body as string)).toEqual({
      text: "ping",
      username: "OMCP",
      channel: "#x",
    });
  });

  it("sendGenericWebhook renders body template with ctx", async () => {
    const r = await sendGenericWebhook(
      {
        url: "https://example.com/hook",
        method: "POST",
        bodyTemplate: '{"event":"{{event}}","session":"{{sessionId}}"}',
        headers: { "X-Session": "{{sessionId}}" },
      },
      { event: "session-end", sessionId: "abc" } as never,
    );
    expect(r.ok).toBe(true);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://example.com/hook");
    expect(init.body).toBe('{"event":"session-end","session":"abc"}');
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Session"]).toBe("abc");
  });
});

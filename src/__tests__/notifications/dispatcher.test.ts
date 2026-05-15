import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { dispatch } from "../../notifications/dispatcher.js";
import type { NotifyConfig, NotifyContext } from "../../notifications/types.js";

const baseCtx: NotifyContext = {
  sessionId: "sess_1",
  projectName: "demo",
  reason: "completed",
  duration: 12_000,
  timestamp: "2026-05-15T00:00:00Z",
};

function okResponse(): Response {
  return new Response("{}", {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("dispatch", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(okResponse() as never);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it("skips telegram when activation flag is not set", async () => {
    const config: NotifyConfig = {
      notifications: {
        enabled: true,
        telegram: { botToken: "T", chatId: "C" },
      },
    };
    const report = await dispatch("session-end", baseCtx, config, { env: {} });
    const tg = report.results.find((r) => r.platform === "telegram");
    expect(tg).toBeDefined();
    expect(tg!.ok).toBe(false);
    expect(tg!.skipped).toBe(true);
    expect(tg!.reason).toBe("not-activated");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("skips disabled events", async () => {
    const config: NotifyConfig = {
      notifications: {
        enabled: true,
        telegram: { botToken: "T", chatId: "C" },
        events: { "session-end": { enabled: false } },
      },
    };
    const report = await dispatch("session-end", baseCtx, config, {
      env: { OMCP_TELEGRAM: "1" },
    });
    const tg = report.results.find((r) => r.platform === "telegram")!;
    expect(tg.skipped).toBe(true);
    expect(tg.reason).toBe("event-disabled");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends telegram with the right URL and JSON body", async () => {
    const config: NotifyConfig = {
      notifications: {
        enabled: true,
        telegram: {
          botToken: "TOKEN123",
          chatId: "999",
          parseMode: "Markdown",
          template: "ended {{projectDisplay}} ({{duration}})",
        },
      },
    };
    const report = await dispatch("session-end", baseCtx, config, {
      env: { OMCP_TELEGRAM: "1" },
    });
    expect(report.results[0].ok).toBe(true);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.telegram.org/botTOKEN123/sendMessage");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(init.body as string);
    expect(body.chat_id).toBe("999");
    expect(body.parse_mode).toBe("Markdown");
    expect(body.text).toBe("ended demo (12s)");
  });

  it("sends discord webhook with content and username", async () => {
    const config: NotifyConfig = {
      notifications: {
        enabled: true,
        discord: {
          webhookUrl: "https://discord.com/api/webhooks/123/abc",
          username: "OMCP",
          mention: "<@123>",
          template: "task done on {{projectDisplay}}",
        },
      },
    };
    const report = await dispatch("session-end", baseCtx, config, {
      env: { OMCP_DISCORD: "1" },
    });
    expect(report.results[0].ok).toBe(true);

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://discord.com/api/webhooks/123/abc");
    const body = JSON.parse(init.body as string);
    expect(body.username).toBe("OMCP");
    expect(body.content).toBe("<@123>\ntask done on demo");
  });

  it("sends slack with text/channel and respects activation", async () => {
    const config: NotifyConfig = {
      notifications: {
        enabled: true,
        slack: {
          webhookUrl: "https://hooks.slack.com/services/AAA/BBB/CCC",
          channel: "#alerts",
          template: "slack: {{projectDisplay}}",
        },
      },
    };
    const report = await dispatch("session-end", baseCtx, config, {
      env: { OMCP_SLACK: "1" },
    });
    expect(report.results[0].ok).toBe(true);

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://hooks.slack.com/services/AAA/BBB/CCC");
    const body = JSON.parse(init.body as string);
    expect(body.text).toBe("slack: demo");
    expect(body.channel).toBe("#alerts");
  });

  it("isolates failures: telegram failing does not stop slack", async () => {
    fetchSpy.mockImplementation((async (url: string) => {
      if (url.includes("telegram")) {
        return new Response('{"description":"boom"}', {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
      return okResponse();
    }) as never);

    const config: NotifyConfig = {
      notifications: {
        enabled: true,
        telegram: { botToken: "T", chatId: "C" },
        slack: { webhookUrl: "https://hooks.slack.com/services/x/y/z" },
      },
    };
    const report = await dispatch("session-end", baseCtx, config, {
      env: { OMCP_TELEGRAM: "1", OMCP_SLACK: "1" },
    });
    const tg = report.results.find((r) => r.platform === "telegram")!;
    const sl = report.results.find((r) => r.platform === "slack")!;
    expect(tg.ok).toBe(false);
    expect(tg.status).toBe(500);
    expect(tg.error).toContain("boom");
    expect(sl.ok).toBe(true);
  });

  it("per-event template overrides platform template", async () => {
    const config: NotifyConfig = {
      notifications: {
        enabled: true,
        telegram: {
          botToken: "T",
          chatId: "C",
          template: "platform-default",
          events: {
            "ask-user-question": { template: "Q: {{question}}" },
          },
        },
      },
    };
    const ctx: NotifyContext = { ...baseCtx, question: "go?" };
    await dispatch("ask-user-question", ctx, config, {
      env: { OMCP_TELEGRAM: "1" },
    });
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
    expect(body.text).toBe("Q: go?");
  });
});

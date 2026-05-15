// Generic webhook transport for custom integrations (OpenClaw, n8n, ClawdBot,
// generic JSON endpoints, etc.).

import type {
  GenericWebhookConfig,
  NotifyContext,
  SendResult,
} from "../types.js";
import { renderTemplate } from "../template.js";

const DEFAULT_BODY_TEMPLATE = JSON.stringify({
  event: "{{event}}",
  sessionId: "{{sessionId}}",
  projectName: "{{projectName}}",
  timestamp: "{{timestamp}}",
});

export async function sendGenericWebhook(
  cfg: GenericWebhookConfig,
  ctx: NotifyContext,
): Promise<SendResult> {
  if (!cfg.url) {
    return { ok: false, status: 0, error: "webhook: missing url" };
  }
  const method = (cfg.method ?? "POST").toUpperCase();
  const tpl = cfg.bodyTemplate ?? DEFAULT_BODY_TEMPLATE;
  const body = renderTemplate(tpl, ctx);

  // Render header VALUES with the same template engine so users can embed
  // {{sessionId}} into things like X-Session headers.
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  for (const [k, v] of Object.entries(cfg.headers ?? {})) {
    headers[k] = renderTemplate(v, ctx);
  }

  const controller = new AbortController();
  const timeoutMs = typeof cfg.timeout === "number" && cfg.timeout > 0 ? cfg.timeout : 10_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const init: RequestInit = { method, headers, signal: controller.signal };
    if (method !== "GET" && method !== "HEAD") init.body = body;
    const res = await fetch(cfg.url, init);
    if (res.ok) return { ok: true, status: res.status };
    const detail = await res.text().catch(() => "");
    return {
      ok: false,
      status: res.status,
      error: detail
        ? `webhook: HTTP ${res.status} ${detail}`
        : `webhook: HTTP ${res.status}`,
    };
  } catch (err) {
    const e = err as Error;
    const msg = e.name === "AbortError" ? `webhook: timeout after ${timeoutMs}ms` : `webhook: ${e.message}`;
    return { ok: false, status: 0, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

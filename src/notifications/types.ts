// Types for the omcp notification dispatcher.
//
// Mirrors the JSON schema documented in
// skills/configure-notifications/SKILL.md (config at ~/.copilot/.omcp-config.json).
// Env vars use the OMCP_* prefix; platform activation requires
// OMCP_TELEGRAM=1, OMCP_DISCORD=1, OMCP_SLACK=1, OMCP_WEBHOOK=1.

export type NotifyEvent =
  | "session-end"
  | "ask-user-question"
  | "session-start"
  | "session-idle"
  | "session-continuing";

export interface NotifyContext {
  // Raw fields (the renderer passes these straight through).
  sessionId?: string;
  projectName?: string;
  projectPath?: string;
  timestamp?: string;
  duration?: number | string;
  durationMs?: number;
  reason?: string;
  question?: string;
  tmuxSession?: string;
  tmuxTail?: string;
  activeMode?: string;
  modes?: string[];
  iteration?: number;
  iterationMax?: number;
  agentName?: string;
  agentType?: string;
  agentsSpawned?: number;
  agentsCompleted?: number;
  contextSummary?: string;
  event?: NotifyEvent;
  // Allow caller-supplied custom fields — template needs them by name.
  [key: string]: unknown;
}

export interface EventOverride {
  enabled?: boolean;
  template?: string;
}

export interface PlatformBase {
  enabled?: boolean;
  template?: string;
  // Per-event override: { "session-end": { template, enabled } }.
  events?: Partial<Record<NotifyEvent, EventOverride>>;
}

export interface TelegramConfig extends PlatformBase {
  botToken: string;
  chatId: string;
  parseMode?: "Markdown" | "MarkdownV2" | "HTML";
}

export interface DiscordWebhookConfig extends PlatformBase {
  webhookUrl: string;
  username?: string;
  mention?: string;
}

export interface DiscordBotConfig extends PlatformBase {
  botToken: string;
  channelId: string;
  mention?: string;
}

export interface SlackConfig extends PlatformBase {
  webhookUrl: string;
  username?: string;
  channel?: string;
  mention?: string;
}

export interface GenericWebhookConfig {
  url: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  bodyTemplate?: string;
  timeout?: number;
}

export interface CliIntegrationConfig {
  command: string;
  args?: string[];
  timeout?: number;
  env?: Record<string, string>;
}

export type CustomIntegrationType = "webhook" | "cli";

export interface CustomIntegration {
  id: string;
  type: CustomIntegrationType;
  preset?: "openclaw" | "n8n" | "clawdbot" | "generic" | string;
  enabled?: boolean;
  config: GenericWebhookConfig | CliIntegrationConfig;
  events?: NotifyEvent[];
  template?: string;
}

export interface EventDefaults {
  enabled?: boolean;
  template?: string;
}

export interface NotificationsSection {
  enabled?: boolean;
  telegram?: TelegramConfig;
  discord?: DiscordWebhookConfig;
  "discord-bot"?: DiscordBotConfig;
  slack?: SlackConfig;
  events?: Partial<Record<NotifyEvent, EventDefaults>>;
}

export interface CustomIntegrationsSection {
  enabled?: boolean;
  integrations: CustomIntegration[];
}

export interface NotifyConfig {
  notifications?: NotificationsSection;
  customIntegrations?: CustomIntegrationsSection;
}

export interface DispatchResult {
  platform: string;
  ok: boolean;
  status?: number;
  error?: string;
  skipped?: boolean;
  reason?: string;
}

export interface DispatchReport {
  event: NotifyEvent;
  results: DispatchResult[];
}

export interface SendResult {
  ok: boolean;
  status: number;
  error?: string;
}

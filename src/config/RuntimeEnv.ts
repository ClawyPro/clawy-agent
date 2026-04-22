/**
 * Environment reading with validation. Centralised so no module reads
 * process.env ad-hoc (and so env-var collisions like the 2026-04-19
 * API_PROXY_PORT K8s-injection bug are caught at boot, not runtime).
 */

import type { AgentConfig } from "../Agent.js";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.length === 0) {
    throw new Error(`Missing required env: ${name}`);
  }
  return v;
}

function optionalEnv(name: string): string | undefined {
  const v = process.env[name];
  return v && v.length > 0 ? v : undefined;
}

function parseIntSafe(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0 || n >= 65536) {
    // Guard specifically against K8s service-discovery injection (e.g.
    // "tcp://10.43.0.1:3001") — see commit 951a9082.
    console.warn(
      `[env] ${name}=${JSON.stringify(raw)} invalid, using ${fallback}`,
    );
    return fallback;
  }
  return n;
}

export interface RuntimeEnv {
  port: number;
  agentConfig: AgentConfig;
}

export function loadRuntimeEnv(): RuntimeEnv {
  const port = parseIntSafe("CORE_AGENT_PORT", 8080);

  const agentConfig: AgentConfig = {
    botId: requireEnv("BOT_ID"),
    userId: requireEnv("USER_ID"),
    workspaceRoot:
      optionalEnv("CORE_AGENT_WORKSPACE") ?? "/home/ocuser/.openclaw/workspace",
    gatewayToken: requireEnv("GATEWAY_TOKEN"),
    apiProxyUrl: requireEnv("CORE_AGENT_API_PROXY_URL"),
    chatProxyUrl: requireEnv("CORE_AGENT_CHAT_PROXY_URL"),
    redisUrl: requireEnv("CORE_AGENT_REDIS_URL"),
    model: optionalEnv("CORE_AGENT_MODEL") ?? "claude-opus-4-6",
    telegramBotToken: optionalEnv("TELEGRAM_BOT_TOKEN"),
    discordBotToken: optionalEnv("DISCORD_BOT_TOKEN"),
    // §7.15 — web/app outbound push via chat-proxy. Both must be set
    // to activate the WebAppChannelAdapter; otherwise the Agent boots
    // without web/app push (Telegram / Discord paths unaffected).
    webAppPushEndpointUrl: optionalEnv("WEBAPP_PUSH_URL"),
    webAppPushHmacKey: optionalEnv("WEBAPP_PUSH_HMAC_KEY"),
  };

  return { port, agentConfig };
}

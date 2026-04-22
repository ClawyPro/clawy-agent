/**
 * clawy-core-agent entrypoint.
 *
 * Design: docs/plans/2026-04-19-clawy-core-agent-design.md
 * Status: Phase 0 — boots, serves /health, returns 501 elsewhere.
 */

import { Agent } from "./Agent.js";
import { HttpServer } from "./transport/HttpServer.js";
import { loadRuntimeEnv } from "./config/RuntimeEnv.js";

async function main(): Promise<void> {
  const env = loadRuntimeEnv();
  const agent = new Agent(env.agentConfig);
  await agent.start();

  const http = new HttpServer({
    port: env.port,
    agent,
    bearerToken: env.agentConfig.gatewayToken || undefined,
  });
  await http.start();

  console.log(
    `[core-agent] botId=${env.agentConfig.botId} port=${env.port} phase=0 ready`,
  );

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    console.log(`[core-agent] ${signal} received, shutting down`);
    try {
      await http.stop();
      await agent.stop();
      process.exit(0);
    } catch (err) {
      console.error("[core-agent] shutdown error", err);
      process.exit(1);
    }
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error("[core-agent] fatal startup error", err);
  process.exit(1);
});

/**
 * `clawy-agent start` — interactive terminal mode.
 *
 * Loads clawy-agent.yaml, creates an Agent + Session, then enters a
 * readline loop: user types a message, the agent streams its response
 * to stdout, repeat. Ctrl+C exits gracefully.
 */

import readline from "node:readline";
import path from "node:path";
import { loadConfig } from "./config.js";
import { Agent, type AgentConfig } from "../Agent.js";
import { Session } from "../Session.js";
import type { AgentEvent, SseWriter } from "../transport/SseWriter.js";
import type { UserMessage, ChannelRef } from "../util/types.js";

// ANSI helpers
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";

/**
 * Minimal SseWriter that prints agent events to stdout. Only text_delta,
 * thinking_delta, tool_start/tool_end, and error events produce visible
 * output; the rest are silently consumed.
 */
class TerminalSseWriter {
  private ended = false;
  private inThinking = false;

  start(): void {
    // no-op — no HTTP headers needed
  }

  agent(event: AgentEvent): void {
    if (this.ended) return;

    switch (event.type) {
      case "text_delta":
        if (this.inThinking) {
          // Close the thinking block before printing regular text
          process.stdout.write(`${RESET}\n`);
          this.inThinking = false;
        }
        process.stdout.write(event.delta);
        break;

      case "thinking_delta":
        if (!this.inThinking) {
          process.stdout.write(`${DIM}`);
          this.inThinking = true;
        }
        process.stdout.write(event.delta);
        break;

      case "tool_start":
        if (this.inThinking) {
          process.stdout.write(`${RESET}\n`);
          this.inThinking = false;
        }
        process.stdout.write(
          `${DIM}[tool] ${event.name}${event.input_preview ? ` ${event.input_preview}` : ""}${RESET}\n`,
        );
        break;

      case "tool_end":
        process.stdout.write(
          `${DIM}[tool] ${event.id} ${event.status} (${event.durationMs}ms)${RESET}\n`,
        );
        break;

      case "error":
        process.stdout.write(
          `\n${YELLOW}Error [${event.code}]: ${event.message}${RESET}\n`,
        );
        break;

      case "turn_end":
        if (this.inThinking) {
          process.stdout.write(`${RESET}`);
          this.inThinking = false;
        }
        break;

      // All other event types are silently consumed.
      default:
        break;
    }
  }

  legacyDelta(_content: string): void {
    // Ignored in terminal mode — we use agent events exclusively.
  }

  legacyFinish(): void {
    // no-op
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    if (this.inThinking) {
      process.stdout.write(`${RESET}`);
      this.inThinking = false;
    }
    // Ensure we end on a newline
    process.stdout.write("\n");
  }
}

/**
 * Build an AgentConfig from the CLI config. The CLI config is simpler
 * than the full K8s RuntimeEnv — we synthesise sensible defaults for
 * fields that only make sense in a cluster context.
 */
function buildAgentConfig(
  config: ReturnType<typeof loadConfig>,
): AgentConfig {
  const workspace = config.workspace
    ? path.resolve(config.workspace)
    : path.resolve("./workspace");

  // Map provider + apiKey to the api-proxy URL format the Agent expects.
  // In standalone mode there's no api-proxy — we set a placeholder and
  // let the LLMClient route directly to the provider.
  const providerBaseUrls: Record<string, string> = {
    anthropic: config.llm.baseUrl ?? "https://api.anthropic.com",
    openai: config.llm.baseUrl ?? "https://api.openai.com",
    google: config.llm.baseUrl ?? "https://generativelanguage.googleapis.com",
  };

  return {
    botId: "cli",
    userId: "cli-user",
    workspaceRoot: workspace,
    gatewayToken: config.llm.apiKey,
    apiProxyUrl: providerBaseUrls[config.llm.provider] ?? "https://api.anthropic.com",
    chatProxyUrl: "",
    redisUrl: "",
    model: config.llm.model,
    telegramBotToken: config.channels?.telegram?.token,
    discordBotToken: config.channels?.discord?.token,
  };
}

export async function runStart(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(`${(err as Error).message}`);
    process.exit(1);
  }

  const agentName = config.identity?.name ?? "Clawy Agent";
  const agentConfig = buildAgentConfig(config);

  // Print welcome banner
  console.log("");
  console.log(`${BOLD}${agentName}${RESET}`);
  console.log(`${DIM}Model: ${config.llm.provider}/${config.llm.model}${RESET}`);
  console.log(`${DIM}Workspace: ${agentConfig.workspaceRoot}${RESET}`);
  console.log(`${DIM}Type your message and press Enter. Ctrl+C to exit.${RESET}`);
  console.log("");

  // Create agent
  const agent = new Agent(agentConfig);
  try {
    await agent.start();
  } catch (err) {
    console.error(`Failed to start agent: ${(err as Error).message}`);
    process.exit(1);
  }

  // Create a persistent session
  const channelRef: ChannelRef = { type: "app", channelId: "cli" };
  const session = await agent.getOrCreateSession("cli:interactive", channelRef);

  // Readline interface
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${GREEN}>${RESET} `,
  });

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n${DIM}Shutting down...${RESET}`);
    rl.close();
    try {
      await agent.stop();
    } catch {
      // swallow
    }
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  rl.prompt();

  rl.on("line", async (line) => {
    const text = line.trim();
    if (!text) {
      rl.prompt();
      return;
    }

    // Special commands
    if (text === "/exit" || text === "/quit") {
      await shutdown();
      return;
    }

    const userMessage: UserMessage = {
      text,
      receivedAt: Date.now(),
    };

    const writer = new TerminalSseWriter();

    try {
      writer.start();
      console.log(""); // blank line before response
      await session.runTurn(
        userMessage,
        writer as unknown as SseWriter,
      );
      writer.end();
    } catch (err) {
      writer.end();
      console.error(
        `${YELLOW}Turn failed: ${(err as Error).message}${RESET}`,
      );
    }

    console.log(""); // blank line after response
    rl.prompt();
  });

  rl.on("close", () => {
    if (!shuttingDown) {
      void shutdown();
    }
  });
}

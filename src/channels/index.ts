/**
 * Barrel export for the channels subsystem.
 *
 * Consumers (Agent.ts, HttpServer.ts) should import from here rather
 * than reaching into individual files — keeps the public surface
 * stable if we rename TelegramPoller → TelegramAdapter later.
 */

export type {
  ChannelAdapter,
  InboundMessage,
  InboundHandler,
  OutboundMessage,
} from "./ChannelAdapter.js";
export { TelegramPoller, type TelegramPollerOptions } from "./TelegramPoller.js";
export { DiscordClient, type DiscordClientOptions, shouldDispatch } from "./DiscordClient.js";
export {
  CaptureSseWriter,
  dispatchInbound,
  buildSessionKey,
} from "./ChannelDispatcher.js";
export { startTypingTicker, type TypingTickerOptions } from "./TypingTicker.js";

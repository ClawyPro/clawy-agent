import { describe, it, expect } from "vitest";
import type { Message } from "discord.js";
import { shouldDispatch, extractDiscordReplyTo } from "./DiscordClient.js";

/**
 * Build a minimal Message-like object — we only stub the fields
 * `shouldDispatch` reads so we don't drag in the whole discord.js
 * class hierarchy.
 */
function makeMessage(opts: {
  content: string;
  isBot?: boolean;
  dmBased?: boolean;
  mentionedUserIds?: string[];
}): Message {
  const mentions = {
    users: {
      has(id: string): boolean {
        return (opts.mentionedUserIds ?? []).includes(id);
      },
    },
  };
  const channel = {
    isDMBased(): boolean {
      return opts.dmBased === true;
    },
    id: "chan-1",
  };
  return {
    content: opts.content,
    author: { bot: opts.isBot === true, id: "user-x" },
    mentions,
    channel,
    id: "msg-1",
  } as unknown as Message;
}

describe("shouldDispatch", () => {
  it("rejects bot-authored messages", () => {
    const m = makeMessage({ content: "hi", isBot: true });
    expect(shouldDispatch(m, "BOT-ID")).toBe(false);
  });

  it("rejects empty content", () => {
    const m = makeMessage({ content: "" });
    expect(shouldDispatch(m, "BOT-ID")).toBe(false);
  });

  it("accepts DM channel regardless of mention", () => {
    const m = makeMessage({ content: "hello", dmBased: true });
    expect(shouldDispatch(m, "BOT-ID")).toBe(true);
  });

  it("accepts guild channel when bot is @mentioned", () => {
    const m = makeMessage({
      content: "<@BOT-ID> help",
      mentionedUserIds: ["BOT-ID"],
    });
    expect(shouldDispatch(m, "BOT-ID")).toBe(true);
  });

  it("rejects guild channel message that does not @mention the bot", () => {
    const m = makeMessage({
      content: "some other chatter",
      mentionedUserIds: ["SOMEONE-ELSE"],
    });
    expect(shouldDispatch(m, "BOT-ID")).toBe(false);
  });

  it("rejects guild message when bot user id is null", () => {
    const m = makeMessage({ content: "hi" });
    expect(shouldDispatch(m, null)).toBe(false);
  });
});

/**
 * Build a Message-like object with a `reference` + cache of the quoted
 * message — the minimum surface `extractDiscordReplyTo` touches.
 */
function makeReplyMessage(opts: {
  referencedId?: string;
  cacheEntry?: { content: string; authorId: string } | null;
}): Message {
  const cache = new Map<string, { content: string; author: { id: string } }>();
  if (opts.referencedId && opts.cacheEntry) {
    cache.set(opts.referencedId, {
      content: opts.cacheEntry.content,
      author: { id: opts.cacheEntry.authorId },
    });
  }
  return {
    reference: opts.referencedId ? { messageId: opts.referencedId } : undefined,
    channel: {
      messages: {
        cache: {
          get: (id: string) => cache.get(id),
        },
      },
    },
  } as unknown as Message;
}

describe("extractDiscordReplyTo", () => {
  it("returns undefined when message has no reference", () => {
    const m = makeReplyMessage({});
    expect(extractDiscordReplyTo(m, "BOT")).toBeUndefined();
  });

  it("returns undefined when quoted message is not in cache (pre-boot)", () => {
    const m = makeReplyMessage({ referencedId: "missing-1" });
    expect(extractDiscordReplyTo(m, "BOT")).toBeUndefined();
  });

  it("returns role=user when quoted author is someone else", () => {
    const m = makeReplyMessage({
      referencedId: "m1",
      cacheEntry: { content: "hello world", authorId: "OTHER" },
    });
    expect(extractDiscordReplyTo(m, "BOT")).toEqual({
      messageId: "m1",
      preview: "hello world",
      role: "user",
    });
  });

  it("returns role=assistant when quoted author is the bot itself", () => {
    const m = makeReplyMessage({
      referencedId: "m2",
      cacheEntry: { content: "I said this earlier", authorId: "BOT" },
    });
    expect(extractDiscordReplyTo(m, "BOT")).toEqual({
      messageId: "m2",
      preview: "I said this earlier",
      role: "assistant",
    });
  });

  it("defaults to role=user when botUserId is null (can't tell)", () => {
    const m = makeReplyMessage({
      referencedId: "m3",
      cacheEntry: { content: "ambiguous", authorId: "SOMEONE" },
    });
    expect(extractDiscordReplyTo(m, null)?.role).toBe("user");
  });
});

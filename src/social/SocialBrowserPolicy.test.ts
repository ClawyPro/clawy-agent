import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  capVisibleText,
  isSocialProviderUrl,
  normalizeSocialProvider,
  parseSocialClaim,
  resolveSocialScreenshotPath,
  validateSocialBrowserInput,
} from "./SocialBrowserPolicy.js";

describe("SocialBrowserPolicy", () => {
  it("normalizes supported providers only", () => {
    expect(normalizeSocialProvider("instagram")).toBe("instagram");
    expect(normalizeSocialProvider("ig")).toBe("instagram");
    expect(normalizeSocialProvider("x")).toBe("x");
    expect(normalizeSocialProvider("twitter")).toBe("x");
    expect(normalizeSocialProvider("facebook")).toBeNull();
  });

  it("keeps navigation scoped to the selected social provider", () => {
    expect(isSocialProviderUrl("instagram", "https://www.instagram.com/direct/inbox/")).toBe(true);
    expect(isSocialProviderUrl("x", "https://twitter.com/home")).toBe(true);
    expect(isSocialProviderUrl("instagram", "https://x.com/home")).toBe(false);
    expect(isSocialProviderUrl("x", "file:///etc/passwd")).toBe(false);
  });

  it("validates read-only tool actions", () => {
    expect(validateSocialBrowserInput({ action: "status", provider: "x" })).toBeNull();
    expect(validateSocialBrowserInput({ action: "open", provider: "x", url: "https://x.com/home" })).toBeNull();
    expect(validateSocialBrowserInput({ action: "open", provider: "x", url: "https://example.com" })).toMatch(/outside provider/);
    expect(validateSocialBrowserInput({ action: "screenshot", provider: "x" })).toMatch(/path/);
  });

  it("scopes screenshot paths under the workspace", () => {
    const root = path.join(path.sep, "tmp", "workspace");
    expect(resolveSocialScreenshotPath(root, "screens/x.png")).toBe(path.join(root, "screens", "x.png"));
    expect(resolveSocialScreenshotPath(root, "../escape.png")).toBeNull();
  });

  it("parses claim responses while keeping the CDP endpoint internal", () => {
    expect(
      parseSocialClaim(JSON.stringify({
        provider: "x",
        sessionId: "sess",
        cdpEndpoint: "ws://secret",
        maxItems: 20,
        expiresAt: 1777777777777,
      })),
    ).toEqual({
      provider: "x",
      sessionId: "sess",
      cdpEndpoint: "ws://secret",
      maxItems: 20,
      expiresAt: 1777777777777,
    });
    expect(parseSocialClaim("{bad")).toBeNull();
  });

  it("caps visible scrape text by item count", () => {
    expect(capVisibleText("one\n\ntwo\nthree", 2)).toBe("one\n\ntwo\n[truncated to 2 visible items]");
  });
});

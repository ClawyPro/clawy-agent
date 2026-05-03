import path from "node:path";

export type SocialProvider = "instagram" | "x";
export type SocialBrowserAction =
  | "status"
  | "open"
  | "snapshot"
  | "scrape_visible"
  | "screenshot"
  | "close";

export interface SocialBrowserInput {
  action: SocialBrowserAction;
  provider: SocialProvider | "ig" | "twitter" | string;
  url?: string;
  path?: string;
  maxItems?: number;
  timeoutMs?: number;
}

export interface SocialClaim {
  provider: SocialProvider;
  sessionId: string;
  cdpEndpoint: string;
  maxItems: number;
  expiresAt?: number;
}

const PROVIDER_ALIASES: Record<string, SocialProvider> = {
  instagram: "instagram",
  ig: "instagram",
  x: "x",
  twitter: "x",
};

const PROVIDER_HOSTS: Record<SocialProvider, string[]> = {
  instagram: ["instagram.com", "www.instagram.com"],
  x: ["x.com", "www.x.com", "twitter.com", "www.twitter.com"],
};

export const DEFAULT_SOCIAL_BROWSER_MAX_ITEMS = 20;

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function normalizeSocialProvider(value: unknown): SocialProvider | null {
  const key = String(value || "").trim().toLowerCase();
  return PROVIDER_ALIASES[key] ?? null;
}

export function isSocialProviderUrl(provider: SocialProvider, rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "https:") return false;
    return PROVIDER_HOSTS[provider].includes(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function resolveSocialScreenshotPath(workspaceRoot: string, relPath: string): string | null {
  if (!stringValue(relPath)) return null;
  const root = path.resolve(workspaceRoot);
  const resolved = path.resolve(root, relPath);
  if (resolved === root || resolved.startsWith(`${root}${path.sep}`)) return resolved;
  return null;
}

export function validateSocialBrowserInput(input: SocialBrowserInput): string | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return "`input` must be an object";
  }
  if (!["status", "open", "snapshot", "scrape_visible", "screenshot", "close"].includes(input.action)) {
    return "`action` must be a supported social browser operation";
  }
  const provider = normalizeSocialProvider(input.provider);
  if (!provider) return "`provider` must be instagram or x";
  if (input.action === "open") {
    const url = stringValue(input.url);
    if (!url) return "`url` is required for open";
    if (!isSocialProviderUrl(provider, url)) return "navigation outside provider is not allowed";
  }
  if (input.action === "screenshot" && !stringValue(input.path)) {
    return "`path` is required for screenshot";
  }
  return null;
}

export function parseSocialClaim(stdout: string): SocialClaim | null {
  try {
    const parsed = JSON.parse(stdout);
    const provider = normalizeSocialProvider(parsed?.provider);
    const sessionId = stringValue(parsed?.sessionId);
    const cdpEndpoint = stringValue(parsed?.cdpEndpoint);
    const maxItems = Number(parsed?.maxItems ?? DEFAULT_SOCIAL_BROWSER_MAX_ITEMS);
    if (!provider || !sessionId || !cdpEndpoint || !Number.isFinite(maxItems)) return null;
    return {
      provider,
      sessionId,
      cdpEndpoint,
      maxItems: Math.max(1, Math.min(DEFAULT_SOCIAL_BROWSER_MAX_ITEMS, Math.trunc(maxItems))),
      ...(typeof parsed?.expiresAt === "number" ? { expiresAt: parsed.expiresAt } : {}),
    };
  } catch {
    return null;
  }
}

export function capVisibleText(text: string, maxItems = DEFAULT_SOCIAL_BROWSER_MAX_ITEMS): string {
  const limit = Math.max(1, Math.min(DEFAULT_SOCIAL_BROWSER_MAX_ITEMS, Math.trunc(maxItems)));
  let seen = 0;
  const kept: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().length > 0) seen++;
    if (seen > limit) {
      kept.push(`[truncated to ${limit} visible items]`);
      return kept.join("\n");
    }
    kept.push(line);
  }
  return text;
}

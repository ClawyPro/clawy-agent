import type { RouteTier, RoutedModel, RoutingProfile } from "./types.js";

const STANDARD_CLASSIFIER_PROMPT = [
  "Classify this user request into exactly one tier.",
  "Reply with ONLY one of LIGHT, MEDIUM, HEAVY, DEEP, XDEEP.",
  "",
  "Rules:",
  "LIGHT: greetings, casual chat, simple Q&A, yes/no, status checks, acknowledgements, short answers.",
  "MEDIUM: analysis, writing, summarizing, research, strategy, reasoning, planning, file ops, memorizing, translations, explanations, recommendations, general tasks.",
  "HEAVY: writing or debugging actual code, complex multi-source technical research.",
  "DEEP: multi-step coding, architecture design, security audits, deep reasoning.",
  "XDEEP: very long-context research, complex multimodal analysis, exhaustive root cause analysis.",
  "",
  "If unsure, choose MEDIUM.",
].join("\n");

const PREMIUM_CLASSIFIER_PROMPT = [
  "Classify this user request into exactly one tier for a premium multi-provider router.",
  "Reply with ONLY one of LIGHT, MEDIUM, HEAVY, DEEP, XDEEP.",
  "",
  "Rules:",
  "LIGHT: greetings, acknowledgements, trivial edits, simple status checks.",
  "MEDIUM: most business work, writing, analysis, planning, summarization, operations, and general assistant tasks.",
  "HEAVY: complex professional analysis, hard research synthesis, and high-stakes reasoning where Claude Opus should handle the work.",
  "DEEP: complex coding, debugging, software architecture, structured implementation, and GPT-style deep reasoning.",
  "XDEEP: very long-context research, large document analysis, multimodal analysis, and tasks where Gemini Pro's long context is the best fit.",
  "",
  "If unsure, choose MEDIUM.",
].join("\n");

function route(
  tier: RouteTier,
  provider: RoutedModel["provider"],
  model: string,
  reason: string,
  opts: Partial<Pick<RoutedModel, "thinking" | "supportsTools" | "supportsImages">> = {},
): RoutedModel {
  return {
    tier,
    provider,
    model,
    reason,
    supportsTools: opts.supportsTools ?? true,
    supportsImages: opts.supportsImages ?? false,
    ...(opts.thinking ? { thinking: opts.thinking } : {}),
  };
}

export const STANDARD_PROFILE: RoutingProfile = {
  id: "standard",
  classifierModel: "gpt-5.4-mini",
  fallbackTier: "MEDIUM",
  classifierPrompt: STANDARD_CLASSIFIER_PROMPT,
  tiers: {
    LIGHT: route("LIGHT", "openai", "gpt-5.4-mini", "standard LIGHT", {
      supportsTools: false,
      supportsImages: false,
    }),
    MEDIUM: route("MEDIUM", "fireworks", "kimi-k2p6", "standard MEDIUM", {
      supportsTools: true,
      supportsImages: false,
    }),
    HEAVY: route("HEAVY", "anthropic", "claude-opus-4-7", "standard HEAVY", {
      supportsTools: true,
      supportsImages: true,
    }),
    DEEP: route("DEEP", "openai", "gpt-5.5", "standard DEEP", {
      thinking: { type: "adaptive" },
      supportsTools: true,
      supportsImages: true,
    }),
    XDEEP: route("XDEEP", "google", "gemini-3.1-pro-preview", "standard XDEEP", {
      thinking: { type: "adaptive" },
      supportsTools: true,
      supportsImages: true,
    }),
  },
  explicitModelRules: [
    { pattern: /\b(opus|claude|클로드|오퍼스)\b/i, tier: "HEAVY" },
    { pattern: /\b(kimi|fireworks|moonshot|키미|문샷)\b/i, tier: "MEDIUM" },
    { pattern: /\b(gpt|openai|오픈ai|오픈AI)\b/i, tier: "DEEP" },
    { pattern: /\b(gemini|google|제미나이|구글)\b/i, tier: "XDEEP" },
  ],
  fastPaths: [
    { id: "heartbeat", pattern: /heartbeat|HEARTBEAT/i, tier: "MEDIUM" },
    {
      id: "session-startup",
      pattern: /session startup|Execute your Session Startup|Conversation info \(untrusted metadata\)/i,
      tier: "MEDIUM",
    },
  ],
};

export const PREMIUM_PROFILE: RoutingProfile = {
  id: "premium",
  classifierModel: "claude-sonnet-4-6",
  fallbackTier: "HEAVY",
  classifierPrompt: PREMIUM_CLASSIFIER_PROMPT,
  tiers: {
    LIGHT: route("LIGHT", "anthropic", "claude-haiku-4-5-20251001", "premium LIGHT", {
      supportsTools: true,
      supportsImages: true,
    }),
    MEDIUM: route("MEDIUM", "anthropic", "claude-opus-4-7", "premium MEDIUM", {
      supportsTools: true,
      supportsImages: true,
    }),
    HEAVY: route("HEAVY", "anthropic", "claude-opus-4-7", "premium HEAVY", {
      thinking: { type: "adaptive" },
      supportsTools: true,
      supportsImages: true,
    }),
    DEEP: route("DEEP", "openai", "gpt-5.5", "premium DEEP", {
      thinking: { type: "adaptive" },
      supportsTools: true,
      supportsImages: true,
    }),
    XDEEP: route("XDEEP", "google", "gemini-3.1-pro-preview", "premium XDEEP", {
      thinking: { type: "adaptive" },
      supportsTools: true,
      supportsImages: true,
    }),
  },
  explicitModelRules: [
    { pattern: /\b(haiku|하이쿠|인사|hello|hi)\b/i, tier: "LIGHT" },
    { pattern: /\b(opus|claude|클로드|오퍼스)\b/i, tier: "HEAVY" },
    { pattern: /\b(code|coding|debug|bug|implement|architecture|코딩|디버그|구현|아키텍처)\b/i, tier: "DEEP" },
    { pattern: /\b(gpt|openai|오픈ai|오픈AI)\b/i, tier: "DEEP" },
    { pattern: /\b(gemini|google|long context|large document|pdf|제미나이|구글|긴\s*문서|대용량)\b/i, tier: "XDEEP" },
  ],
  fastPaths: [
    { id: "heartbeat", pattern: /heartbeat|HEARTBEAT/i, tier: "LIGHT" },
    {
      id: "session-startup",
      pattern: /session startup|Execute your Session Startup|Conversation info \(untrusted metadata\)/i,
      tier: "MEDIUM",
    },
  ],
};

export const ANTHROPIC_ONLY_PROFILE: RoutingProfile = {
  ...STANDARD_PROFILE,
  id: "anthropic_only",
  tiers: {
    LIGHT: route("LIGHT", "anthropic", "claude-haiku-4-5-20251001", "anthropic-only LIGHT", {
      supportsTools: true,
      supportsImages: true,
    }),
    MEDIUM: route("MEDIUM", "anthropic", "claude-sonnet-4-6", "anthropic-only MEDIUM", {
      supportsTools: true,
      supportsImages: true,
    }),
    HEAVY: route("HEAVY", "anthropic", "claude-opus-4-7", "anthropic-only HEAVY", {
      supportsTools: true,
      supportsImages: true,
    }),
    DEEP: route("DEEP", "anthropic", "claude-opus-4-7", "anthropic-only DEEP", {
      thinking: { type: "adaptive" },
      supportsTools: true,
      supportsImages: true,
    }),
    XDEEP: route("XDEEP", "anthropic", "claude-opus-4-7", "anthropic-only XDEEP", {
      thinking: { type: "adaptive" },
      supportsTools: true,
      supportsImages: true,
    }),
  },
};

export function getRoutingProfile(id: string | undefined): RoutingProfile {
  if (id === "premium") return PREMIUM_PROFILE;
  if (id === "anthropic_only") return ANTHROPIC_ONLY_PROFILE;
  return STANDARD_PROFILE;
}

export function resolveExplicitModelPreference(
  profile: RoutingProfile,
  text: string,
): RoutedModel | null {
  for (const rule of profile.explicitModelRules) {
    if (rule.pattern.test(text)) return profile.tiers[rule.tier];
  }
  return null;
}

export function routeSupportsTools(route: RoutedModel): boolean {
  return route.supportsTools;
}

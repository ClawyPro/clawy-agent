import type { LLMEvent, LLMMessage, LLMStreamRequest } from "../transport/LLMClient.js";
import { extractLatestUserText } from "./messageText.js";
import { getRoutingProfile, resolveExplicitModelPreference } from "./profiles.js";
import type { RouteDecision, RoutedModel, RouteTier, RoutingProfile } from "./types.js";

export interface RouterEngineLLM {
  stream(req: LLMStreamRequest): AsyncGenerator<LLMEvent, void, void>;
}

export interface RouterEngineOptions {
  llm: RouterEngineLLM;
  profileId?: string;
}

export interface RouteResolveInput {
  configuredModel: string;
  messages: LLMMessage[];
  hasTools: boolean;
  hasImages: boolean;
}

const ROUTE_ORDER: RouteTier[] = ["LIGHT", "MEDIUM", "HEAVY", "DEEP", "XDEEP"];

export class RouterEngine {
  private readonly llm: RouterEngineLLM;
  private readonly profile: RoutingProfile;

  constructor(options: RouterEngineOptions) {
    this.llm = options.llm;
    this.profile = getRoutingProfile(options.profileId);
  }

  async resolve(input: RouteResolveInput): Promise<RouteDecision> {
    const text = extractLatestUserText(input.messages).trim();

    for (const rule of this.profile.fastPaths) {
      if (rule.pattern.test(text)) {
        return this.finalize(this.profile.tiers[rule.tier], input, {
          classifierUsed: false,
          confidence: "rule",
          classifierRaw: rule.id,
        });
      }
    }

    const explicit = resolveExplicitModelPreference(this.profile, text);
    if (explicit) {
      return this.finalize(explicit, input, {
        classifierUsed: false,
        confidence: "rule",
        classifierRaw: "explicit-model",
      });
    }

    const raw = await this.classify(text);
    const tier = parseTier(raw);
    if (!tier) {
      return this.finalize(this.profile.tiers[this.profile.fallbackTier], input, {
        classifierUsed: true,
        confidence: "fallback",
        classifierRaw: raw,
      });
    }

    return this.finalize(this.profile.tiers[tier], input, {
      classifierUsed: true,
      confidence: "classifier",
      classifierRaw: raw,
    });
  }

  private async classify(text: string): Promise<string> {
    let out = "";
    try {
      const stream = this.llm.stream({
        model: this.profile.classifierModel,
        messages: [
          {
            role: "user",
            content: `${this.profile.classifierPrompt}\n\nUser message:\n${text}`,
          },
        ],
        max_tokens: 10,
        temperature: 0,
        thinking: { type: "disabled" },
      });
      for await (const evt of stream) {
        if (evt.kind === "text_delta") out += evt.delta;
        if (evt.kind === "error") return "";
      }
      return out.trim().toUpperCase();
    } catch (err) {
      console.warn(`[router] classifier failed: ${(err as Error).message}`);
      return "";
    }
  }

  private finalize(
    route: RoutedModel,
    input: RouteResolveInput,
    meta: Pick<RouteDecision, "classifierUsed" | "classifierRaw" | "confidence">,
  ): RouteDecision {
    const safeRoute = applyCapabilityGates(this.profile, route, input);
    return {
      ...safeRoute,
      profileId: this.profile.id,
      classifierUsed: meta.classifierUsed,
      classifierModel: this.profile.classifierModel,
      confidence: meta.confidence,
      ...(meta.classifierRaw ? { classifierRaw: meta.classifierRaw } : {}),
    };
  }
}

function parseTier(raw: string): RouteTier | null {
  const normalized = raw.toUpperCase();
  if (normalized.includes("XDEEP")) return "XDEEP";
  if (normalized.includes("DEEP")) return "DEEP";
  if (normalized.includes("HEAVY")) return "HEAVY";
  if (normalized.includes("MEDIUM")) return "MEDIUM";
  if (normalized.includes("LIGHT")) return "LIGHT";
  return null;
}

function applyCapabilityGates(
  profile: RoutingProfile,
  route: RoutedModel,
  input: RouteResolveInput,
): RoutedModel {
  if ((!input.hasTools || route.supportsTools) && (!input.hasImages || route.supportsImages)) {
    return route;
  }

  const currentIndex = ROUTE_ORDER.indexOf(route.tier);
  for (const tier of ROUTE_ORDER.slice(Math.max(0, currentIndex))) {
    const candidate = profile.tiers[tier];
    if (input.hasTools && !candidate.supportsTools) continue;
    if (input.hasImages && !candidate.supportsImages) continue;
    return {
      ...candidate,
      reason: `${candidate.reason}; escalated from ${route.tier} for capability gate`,
    };
  }

  return profile.tiers[profile.fallbackTier];
}

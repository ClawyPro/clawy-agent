import type { Tool, ToolContext, ToolResult } from "../Tool.js";

export interface ClockInput {
  timezone?: string;
  requirementId?: string;
}

export interface ClockOutput {
  timestampMs: number;
  iso: string;
  timezone: string;
  localDate: string;
  localTime: string;
}

export interface ClockToolOptions {
  now?: () => Date;
}

const INPUT_SCHEMA = {
  type: "object",
  properties: {
    timezone: {
      type: "string",
      description: "IANA timezone. Defaults to UTC.",
    },
    requirementId: {
      type: "string",
      description: "Optional deterministic requirement id this clock evidence satisfies.",
    },
  },
  additionalProperties: false,
} as const;

function partsFor(date: Date, timezone: string): Record<string, string> {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  return Object.fromEntries(
    formatter.formatToParts(date).map((part) => [part.type, part.value]),
  );
}

function localDateTime(date: Date, timezone: string): Pick<ClockOutput, "localDate" | "localTime"> {
  const p = partsFor(date, timezone);
  return {
    localDate: `${p.year}-${p.month}-${p.day}`,
    localTime: `${p.hour}:${p.minute}:${p.second}`,
  };
}

function validateTimezone(timezone: string): string | null {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
    return null;
  } catch {
    return `invalid timezone: ${timezone}`;
  }
}

export function makeClockTool(opts: ClockToolOptions = {}): Tool<ClockInput, ClockOutput> {
  const now = opts.now ?? (() => new Date());
  return {
    name: "Clock",
    description:
      "Return the runtime current time deterministically. Use before date math, relative periods, deadlines, recency, or time-sensitive numeric answers.",
    inputSchema: INPUT_SCHEMA,
    permission: "read",
    validate(input) {
      if (input?.timezone && validateTimezone(input.timezone)) {
        return validateTimezone(input.timezone);
      }
      return null;
    },
    async execute(input: ClockInput, ctx: ToolContext): Promise<ToolResult<ClockOutput>> {
      const started = Date.now();
      const timezone = input.timezone || "UTC";
      const timezoneError = validateTimezone(timezone);
      if (timezoneError) {
        return {
          status: "error",
          errorCode: "invalid_timezone",
          errorMessage: timezoneError,
          durationMs: Date.now() - started,
        };
      }
      const date = now();
      const output: ClockOutput = {
        timestampMs: date.getTime(),
        iso: date.toISOString(),
        timezone,
        ...localDateTime(date, timezone),
      };
      const requirementIds = input.requirementId ? [input.requirementId] : [];
      ctx.executionContract?.recordDeterministicEvidence({
        evidenceId: `de_clock_${ctx.turnId}_${date.getTime().toString(36)}`,
        turnId: ctx.turnId,
        requirementIds,
        toolName: "Clock",
        kind: "clock",
        status: "passed",
        inputSummary: `timezone=${timezone}`,
        output,
        assertions: [`iso=${output.iso}`, `localDate=${output.localDate}`],
        resources: [],
      });
      return {
        status: "ok",
        output,
        durationMs: Date.now() - started,
        metadata: { deterministicEvidence: true },
      };
    },
  };
}

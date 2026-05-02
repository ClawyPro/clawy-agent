import type { Tool, ToolContext, ToolResult } from "../Tool.js";

export type DateRangeMode =
  | "explicit"
  | "last_n_days"
  | "month_to_date"
  | "previous_month"
  | "year_to_date";

export interface DateRangeInput {
  mode: DateRangeMode;
  timezone?: string;
  days?: number;
  startDate?: string;
  endDate?: string;
  requirementId?: string;
}

export interface DateRangeOutput {
  mode: DateRangeMode;
  startDate: string;
  endDate: string;
  dayCount: number;
  timezone: string;
  inclusiveEnd: boolean;
}

export interface DateRangeToolOptions {
  now?: () => Date;
}

const INPUT_SCHEMA = {
  type: "object",
  properties: {
    mode: {
      type: "string",
      enum: ["explicit", "last_n_days", "month_to_date", "previous_month", "year_to_date"],
    },
    timezone: { type: "string", description: "IANA timezone. Defaults to UTC." },
    days: { type: "integer", minimum: 1, maximum: 366 },
    startDate: { type: "string", description: "YYYY-MM-DD for explicit ranges." },
    endDate: { type: "string", description: "YYYY-MM-DD for explicit ranges." },
    requirementId: { type: "string" },
  },
  required: ["mode"],
  additionalProperties: false,
} as const;

function validateTimezone(timezone: string): string | null {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
    return null;
  } catch {
    return `invalid timezone: ${timezone}`;
  }
}

function localYmd(date: Date, timezone: string): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const p = Object.fromEntries(
    formatter.formatToParts(date).map((part) => [part.type, part.value]),
  );
  return `${p.year}-${p.month}-${p.day}`;
}

function parseYmd(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatYmd(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function dayCountInclusive(start: Date, end: Date): number {
  return Math.floor((end.getTime() - start.getTime()) / 86_400_000) + 1;
}

function startOfMonth(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function startOfYear(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
}

function previousMonthRange(anchor: Date): { start: Date; end: Date } {
  const start = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() - 1, 1));
  const end = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), 0));
  return { start, end };
}

function validateInput(input: DateRangeInput): string | null {
  if (!input || typeof input !== "object") return "`input` must be an object";
  if (!input.mode) return "`mode` is required";
  if (input.timezone && validateTimezone(input.timezone)) {
    return validateTimezone(input.timezone);
  }
  if (input.mode === "last_n_days" && (!input.days || input.days < 1)) {
    return "`days` must be >= 1 for last_n_days";
  }
  if (input.mode === "explicit") {
    if (!input.startDate || !input.endDate) {
      return "`startDate` and `endDate` are required for explicit ranges";
    }
    const start = parseYmd(input.startDate);
    const end = parseYmd(input.endDate);
    if (!start || !end) return "explicit dates must use YYYY-MM-DD";
    if (start.getTime() > end.getTime()) return "`startDate` must be on or before `endDate`";
  }
  return null;
}

export function makeDateRangeTool(
  opts: DateRangeToolOptions = {},
): Tool<DateRangeInput, DateRangeOutput> {
  const now = opts.now ?? (() => new Date());
  return {
    name: "DateRange",
    description:
      "Compute exact date ranges deterministically. Use after Clock for relative periods like recent N days, previous month, month-to-date, or year-to-date.",
    inputSchema: INPUT_SCHEMA,
    permission: "read",
    validate: validateInput,
    async execute(input: DateRangeInput, ctx: ToolContext): Promise<ToolResult<DateRangeOutput>> {
      const started = Date.now();
      const validation = validateInput(input);
      if (validation) {
        return {
          status: "error",
          errorCode: "invalid_date_range_input",
          errorMessage: validation,
          durationMs: Date.now() - started,
        };
      }
      const timezone = input.timezone || "UTC";
      const anchor = parseYmd(localYmd(now(), timezone))!;
      let start: Date;
      let end: Date;
      if (input.mode === "explicit") {
        start = parseYmd(input.startDate!)!;
        end = parseYmd(input.endDate!)!;
      } else if (input.mode === "last_n_days") {
        end = anchor;
        start = addDays(anchor, -(input.days! - 1));
      } else if (input.mode === "month_to_date") {
        end = anchor;
        start = startOfMonth(anchor);
      } else if (input.mode === "previous_month") {
        ({ start, end } = previousMonthRange(anchor));
      } else {
        end = anchor;
        start = startOfYear(anchor);
      }
      const output: DateRangeOutput = {
        mode: input.mode,
        startDate: formatYmd(start),
        endDate: formatYmd(end),
        dayCount: dayCountInclusive(start, end),
        timezone,
        inclusiveEnd: true,
      };
      const requirementIds = input.requirementId ? [input.requirementId] : [];
      ctx.executionContract?.recordDeterministicEvidence({
        evidenceId: `de_date_range_${ctx.turnId}_${output.startDate}_${output.endDate}`,
        turnId: ctx.turnId,
        requirementIds,
        toolName: "DateRange",
        kind: "date_range",
        status: "passed",
        inputSummary: `${input.mode} timezone=${timezone}`,
        output,
        assertions: [
          `startDate=${output.startDate}`,
          `endDate=${output.endDate}`,
          `dayCount=${output.dayCount}`,
        ],
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

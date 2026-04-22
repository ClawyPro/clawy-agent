import { describe, it, expect } from "vitest";
import { parseCron, getNextFireAt } from "./cronParser.js";

describe("cronParser", () => {
  it("parses 5-field wildcards", () => {
    const f = parseCron("* * * * *");
    expect(f.minute.size).toBe(60);
    expect(f.hour.size).toBe(24);
  });

  it("parses step notation */5", () => {
    const f = parseCron("*/5 * * * *");
    expect(f.minute.has(0)).toBe(true);
    expect(f.minute.has(5)).toBe(true);
    expect(f.minute.has(7)).toBe(false);
    expect(f.minute.size).toBe(12);
  });

  it("parses literal + list + range", () => {
    const f = parseCron("0,15,30 9-17 * * 1-5");
    expect([...f.minute].sort((a, b) => a - b)).toEqual([0, 15, 30]);
    expect(f.hour.has(9)).toBe(true);
    expect(f.hour.has(17)).toBe(true);
    expect(f.hour.has(18)).toBe(false);
    expect([...f.dayOfWeek].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });

  it("resolves @hourly / @daily / @weekly shorthand", () => {
    expect(parseCron("@hourly").minute.size).toBe(1);
    expect(parseCron("@daily").hour.size).toBe(1);
    expect(parseCron("@weekly").dayOfWeek.size).toBe(1);
  });

  it("rejects bad expressions", () => {
    expect(() => parseCron("* * * *")).toThrow(/5 fields/);
    expect(() => parseCron("60 * * * *")).toThrow(/bad value/);
    expect(() => parseCron("*/0 * * * *")).toThrow(/bad step/);
    expect(() => parseCron("5-3 * * * *")).toThrow(/bad range/);
  });

  it("getNextFireAt — @hourly from 10:30", () => {
    const after = new Date("2026-04-20T10:30:00");
    const next = getNextFireAt("@hourly", after);
    expect(next.getHours()).toBe(11);
    expect(next.getMinutes()).toBe(0);
  });

  it("getNextFireAt — every 15 minutes", () => {
    const after = new Date("2026-04-20T10:07:00");
    const next = getNextFireAt("*/15 * * * *", after);
    expect(next.getMinutes()).toBe(15);
  });

  it("getNextFireAt — weekday 9am", () => {
    const mondayEve = new Date("2026-04-20T17:00:00");
    const next = getNextFireAt("0 9 * * 1-5", mondayEve);
    expect(next.getDate()).toBe(21);
    expect(next.getHours()).toBe(9);
  });

  it("POSIX OR semantics: dom + dow both restricted", () => {
    const start = new Date("2026-04-01T00:00:00");
    const next = getNextFireAt("0 0 13 * 5", start);
    expect(next.getDate()).toBe(3);
  });
});

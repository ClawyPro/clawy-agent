/**
 * HeartbeatMonitor unit tests.
 *
 * Uses a hand-rolled fake clock + scheduler rather than
 * `vi.useFakeTimers()` so the event ordering is deterministic (real
 * setTimeout fires in insertion order but the fake timers interact
 * with the host loop in surprising ways under vitest concurrency).
 */

import { describe, it, expect } from "vitest";
import type { ServerResponse } from "node:http";
import {
  HeartbeatMonitor,
  wrapSseWithMonitor,
  HEARTBEAT_SILENCE_MS,
  HEARTBEAT_INTERVAL_MS,
  type HeartbeatClock,
} from "./HeartbeatMonitor.js";
import { SseWriter, type AgentEvent } from "../transport/SseWriter.js";

interface ScheduledTask {
  cb: () => void;
  fireAt: number;
  cancelled: boolean;
}

function makeFakeClock(): {
  clock: HeartbeatClock;
  advance: (ms: number) => void;
  setNow: (t: number) => void;
  now: () => number;
  pending: () => number;
} {
  let t = 0;
  const queue: ScheduledTask[] = [];
  const clock: HeartbeatClock = {
    now: () => t,
    schedule: (cb, delayMs) => {
      const task: ScheduledTask = { cb, fireAt: t + delayMs, cancelled: false };
      queue.push(task);
      return () => {
        task.cancelled = true;
      };
    },
  };
  const advance = (ms: number): void => {
    const target = t + ms;
    // Repeatedly fire any task whose fireAt <= target, updating `t`.
    for (;;) {
      const due = queue
        .filter((tk) => !tk.cancelled && tk.fireAt <= target)
        .sort((a, b) => a.fireAt - b.fireAt);
      if (due.length === 0) break;
      const next = due[0]!;
      t = next.fireAt;
      next.cancelled = true;
      next.cb();
    }
    t = target;
  };
  return {
    clock,
    advance,
    setNow: (v) => {
      t = v;
    },
    now: () => t,
    pending: () => queue.filter((x) => !x.cancelled).length,
  };
}

class RecordingSse extends SseWriter {
  readonly events: AgentEvent[] = [];
  constructor() {
    super({
      writeHead: () => {},
      write: () => true,
      end: () => {},
    } as unknown as ServerResponse);
  }
  override agent(event: AgentEvent): void {
    this.events.push(event);
  }
  override legacyDelta(): void {}
  override legacyFinish(): void {}
  override start(): void {}
  override end(): void {}
}

describe("HeartbeatMonitor", () => {
  it("does not emit when iteration completes quickly", () => {
    const fake = makeFakeClock();
    const sse = new RecordingSse();
    const hb = new HeartbeatMonitor({ sse, turnId: "T", clock: fake.clock });
    hb.start(0);
    // Fast iteration — tool emits at 5s, then stops.
    fake.advance(5_000);
    hb.ping({ type: "text_delta", delta: "hi" });
    hb.stop();
    fake.advance(60_000);
    expect(sse.events.filter((e) => e.type === "heartbeat").length).toBe(0);
    expect(hb.getHeartbeatsEmitted()).toBe(0);
  });

  it("fires first heartbeat after 20s of silence", () => {
    const fake = makeFakeClock();
    const sse = new RecordingSse();
    const hb = new HeartbeatMonitor({ sse, turnId: "T", clock: fake.clock });
    hb.start(3);
    fake.advance(HEARTBEAT_SILENCE_MS);
    const hbs = sse.events.filter((e) => e.type === "heartbeat");
    expect(hbs.length).toBe(1);
    const first = hbs[0];
    if (!first || first.type !== "heartbeat") throw new Error("expected heartbeat");
    expect(first.turnId).toBe("T");
    expect(first.iter).toBe(3);
    expect(first.elapsedMs).toBe(HEARTBEAT_SILENCE_MS);
    hb.stop();
  });

  it("continues heartbeating at 30s intervals after the first", () => {
    const fake = makeFakeClock();
    const sse = new RecordingSse();
    const hb = new HeartbeatMonitor({ sse, turnId: "T", clock: fake.clock });
    hb.start(0);
    fake.advance(HEARTBEAT_SILENCE_MS); // first heartbeat
    fake.advance(HEARTBEAT_INTERVAL_MS); // second heartbeat (30s later)
    fake.advance(HEARTBEAT_INTERVAL_MS); // third heartbeat
    const hbs = sse.events.filter((e) => e.type === "heartbeat");
    expect(hbs.length).toBe(3);
    hb.stop();
  });

  it("an emission resets the silence clock — next heartbeat waits another 20s", () => {
    const fake = makeFakeClock();
    const sse = new RecordingSse();
    const hb = new HeartbeatMonitor({ sse, turnId: "T", clock: fake.clock });
    hb.start(0);
    // Silence, then emit at 10s.
    fake.advance(10_000);
    hb.ping({ type: "text_delta", delta: "x" });
    // Only 15s more = 25s total — no heartbeat yet because the ping
    // reset the silence clock.
    fake.advance(15_000);
    expect(sse.events.filter((e) => e.type === "heartbeat").length).toBe(0);
    // 20s past the ping (25s after start) should have fired though —
    // wait that out: advance to exactly 20s after the last ping.
    fake.advance(5_000);
    expect(sse.events.filter((e) => e.type === "heartbeat").length).toBe(1);
    hb.stop();
  });

  it("stop() cancels pending timer", () => {
    const fake = makeFakeClock();
    const sse = new RecordingSse();
    const hb = new HeartbeatMonitor({ sse, turnId: "T", clock: fake.clock });
    hb.start(0);
    hb.stop();
    fake.advance(HEARTBEAT_SILENCE_MS * 5);
    expect(sse.events.filter((e) => e.type === "heartbeat").length).toBe(0);
  });

  it("heartbeat events themselves do not reset the silence clock", () => {
    const fake = makeFakeClock();
    const sse = new RecordingSse();
    const hb = new HeartbeatMonitor({ sse, turnId: "T", clock: fake.clock });
    hb.start(0);
    fake.advance(HEARTBEAT_SILENCE_MS); // hb #1
    // Feed the heartbeat event through the ping path (simulating the
    // wrapper forwarding it). Must NOT reset.
    hb.ping({
      type: "heartbeat",
      turnId: "T",
      iter: 0,
      elapsedMs: HEARTBEAT_SILENCE_MS,
      lastEventAt: 0,
    });
    fake.advance(HEARTBEAT_INTERVAL_MS); // hb #2
    expect(sse.events.filter((e) => e.type === "heartbeat").length).toBe(2);
    hb.stop();
  });
});

describe("wrapSseWithMonitor", () => {
  it("forwards agent() to the real sse AND pings the monitor", () => {
    const fake = makeFakeClock();
    const sse = new RecordingSse();
    const hb = new HeartbeatMonitor({ sse, turnId: "T", clock: fake.clock });
    hb.start(0);
    const wrapped = wrapSseWithMonitor(sse, hb);
    // Advance 10s of silence, then emit via wrapper.
    fake.advance(10_000);
    wrapped.agent({ type: "text_delta", delta: "hello" });
    // 19s after the emit — still no heartbeat (silence reset by the ping).
    fake.advance(19_000);
    expect(sse.events.filter((e) => e.type === "heartbeat").length).toBe(0);
    // 1s more — 20s since the emit — heartbeat fires.
    fake.advance(1_000);
    expect(sse.events.filter((e) => e.type === "heartbeat").length).toBe(1);
    // The real event is present too.
    expect(sse.events.filter((e) => e.type === "text_delta").length).toBe(1);
    hb.stop();
  });
});

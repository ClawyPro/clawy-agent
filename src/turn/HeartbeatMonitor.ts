/**
 * HeartbeatMonitor — B5 pipeline heartbeat.
 *
 * Wraps an SseWriter so `agent()` invocations "ping" a silence timer.
 * If HEARTBEAT_SILENCE_MS (20s) elapse within a single iteration
 * without any SSE emission, the monitor starts emitting `heartbeat`
 * agent events every HEARTBEAT_INTERVAL_MS (30s). Any subsequent
 * emission resets the silence clock — the next heartbeat only fires
 * after another 20s of silence.
 *
 * Scoped to one iteration. `start(iter)` begins observation;
 * `stop()` disposes the timer + drops the wrapper back to the raw
 * SseWriter. The wrapper is fail-safe: observation bookkeeping can
 * throw without affecting the real SSE write.
 *
 * The monitor accepts `now` + `schedule` injections so tests can drive
 * it off fake timers without depending on `vi.useFakeTimers()`
 * interacting with `setTimeout`.
 */

import type { SseWriter, AgentEvent } from "../transport/SseWriter.js";

/** Silence threshold before the first heartbeat fires. */
export const HEARTBEAT_SILENCE_MS = 20_000;

/** Cadence once heartbeating has started. */
export const HEARTBEAT_INTERVAL_MS = 30_000;

export interface HeartbeatClock {
  now(): number;
  schedule(cb: () => void, delayMs: number): () => void;
}

export const REAL_CLOCK: HeartbeatClock = {
  now: () => Date.now(),
  schedule: (cb, delayMs) => {
    const t = setTimeout(cb, delayMs);
    if (typeof (t as { unref?: () => void }).unref === "function") {
      (t as { unref?: () => void }).unref?.();
    }
    return () => clearTimeout(t);
  },
};

export interface HeartbeatMonitorOptions {
  sse: SseWriter;
  turnId: string;
  clock?: HeartbeatClock;
}

/**
 * `agent()` proxy + silence timer manager. The wrapper is deliberately
 * thin: the only state is `lastEventAt` + the active timeout handle.
 * On each `emit`, we update `lastEventAt` and re-arm the timer; the
 * timer callback checks silence, emits a heartbeat if needed, and
 * re-arms itself.
 */
export class HeartbeatMonitor {
  private readonly clock: HeartbeatClock;
  private readonly sse: SseWriter;
  private readonly turnId: string;
  private iter = -1;
  private iterStartedAt = 0;
  private lastEventAt = 0;
  private running = false;
  private heartbeatsEmitted = 0;
  private cancel: (() => void) | null = null;

  constructor(opts: HeartbeatMonitorOptions) {
    this.sse = opts.sse;
    this.turnId = opts.turnId;
    this.clock = opts.clock ?? REAL_CLOCK;
  }

  /** Begin monitoring the given iteration. Resets silence clock. */
  start(iter: number): void {
    this.stop();
    this.iter = iter;
    const t = this.clock.now();
    this.iterStartedAt = t;
    this.lastEventAt = t;
    this.heartbeatsEmitted = 0;
    this.running = true;
    this.arm(HEARTBEAT_SILENCE_MS);
  }

  /** Stop monitoring — disposes the timer. Idempotent. */
  stop(): void {
    this.running = false;
    if (this.cancel) {
      this.cancel();
      this.cancel = null;
    }
  }

  /**
   * Record an SSE emission. Callers wrap `sse.agent` and invoke this
   * AFTER the real write so a heartbeat emission doesn't recursively
   * reset its own clock (we filter heartbeat emissions below).
   */
  ping(event: AgentEvent): void {
    if (!this.running) return;
    // A heartbeat event MUST NOT reset its own clock — otherwise no
    // follow-up heartbeat would ever fire in a fully-silent iteration.
    if (event.type === "heartbeat") return;
    this.lastEventAt = this.clock.now();
    // Re-arm for another SILENCE_MS of quiet. We reset
    // heartbeatsEmitted here so a post-emit silence gap starts fresh.
    this.heartbeatsEmitted = 0;
    this.arm(HEARTBEAT_SILENCE_MS);
  }

  /** Test-only — number of heartbeat events emitted. */
  getHeartbeatsEmitted(): number {
    return this.heartbeatsEmitted;
  }

  private arm(delayMs: number): void {
    if (this.cancel) {
      this.cancel();
      this.cancel = null;
    }
    if (!this.running) return;
    this.cancel = this.clock.schedule(() => this.onTick(), delayMs);
  }

  private onTick(): void {
    this.cancel = null;
    if (!this.running) return;
    const now = this.clock.now();
    const elapsedSinceLast = now - this.lastEventAt;
    // Grace: the timer could fire slightly early on some platforms;
    // if we haven't actually exceeded the silence threshold (or the
    // interval, once heartbeating), re-arm for the remainder.
    const needed =
      this.heartbeatsEmitted === 0 ? HEARTBEAT_SILENCE_MS : HEARTBEAT_INTERVAL_MS;
    if (elapsedSinceLast < needed) {
      this.arm(needed - elapsedSinceLast);
      return;
    }
    // Emit heartbeat and re-arm for the interval.
    const event: AgentEvent = {
      type: "heartbeat",
      turnId: this.turnId,
      iter: this.iter,
      elapsedMs: now - this.iterStartedAt,
      lastEventAt: this.lastEventAt,
    };
    this.heartbeatsEmitted++;
    try {
      this.sse.agent(event);
    } catch {
      // Never let an SSE write error crash the timer callback; the
      // iteration will eventually complete (or abort) and `stop()`
      // the monitor.
    }
    this.arm(HEARTBEAT_INTERVAL_MS);
  }
}

/**
 * Build a writer-like facade that forwards every method onto the real
 * SseWriter while pinging the monitor on `agent()`. The returned
 * object shares the same observable behaviour as the underlying
 * SseWriter so downstream code (ToolDispatcher, LLMStreamReader) is
 * transparent to the monitor's presence.
 */
export function wrapSseWithMonitor(
  sse: SseWriter,
  monitor: HeartbeatMonitor,
): SseWriter {
  // Build a thin proxy; we can't subclass cleanly because SseWriter's
  // constructor takes a ServerResponse. Instead we create a plain
  // object whose prototype is the original instance's prototype — so
  // `instanceof SseWriter` still holds for callers that check.
  const wrapper = Object.create(sse) as SseWriter & {
    agent: (e: AgentEvent) => void;
  };
  wrapper.agent = (event: AgentEvent): void => {
    // Perform the real write first, then ping — so if the ping
    // bookkeeping throws, the user still gets the event.
    sse.agent(event);
    try {
      monitor.ping(event);
    } catch {
      /* fail-open — heartbeat bookkeeping must never drop events. */
    }
  };
  return wrapper;
}

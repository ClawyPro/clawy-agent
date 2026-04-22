/**
 * SessionHeartbeat — B5 session-alive heartbeat file.
 *
 * Writes `{workspaceRoot}/core-agent/sessions/{sessionKey}/heartbeat.json`
 * every 10s while a Turn is executing. External callers (parent agents,
 * chat-proxy, health-monitor) can read the file or hit the HTTP endpoint
 * to cheaply verify session liveness without expensive session-list scans.
 *
 * Lifecycle:
 *   start(turnId, iter)  — begin writing; immediate first write
 *   updateIteration(n)   — called each loop iteration
 *   stop()               — final write with alive:false + completedAt
 *
 * All filesystem errors are swallowed after the initial start() —
 * heartbeat is best-effort and must never crash a turn.
 */

import nodefs from "node:fs/promises";
import path from "node:path";

/** Interval between heartbeat file writes. */
export const HEARTBEAT_FILE_INTERVAL_MS = 10_000;

export interface HeartbeatFileData {
  alive: boolean;
  sessionKey: string;
  turnId: string;
  iteration: number;
  lastActivityMs: number;
  updatedAt: string;
  completedAt?: string;
}

/** Filesystem abstraction for testing. */
export interface HeartbeatFs {
  mkdir(p: string): Promise<void>;
  writeFile(p: string, data: string): Promise<void>;
  readFile(p: string): Promise<string>;
  unlink(p: string): Promise<void>;
}

const REAL_FS: HeartbeatFs = {
  mkdir: (p) => nodefs.mkdir(p, { recursive: true }).then(() => {}),
  writeFile: (p, d) => nodefs.writeFile(p, d, "utf8"),
  readFile: (p) => nodefs.readFile(p, "utf8"),
  unlink: (p) => nodefs.unlink(p).catch(() => {}),
};

export interface SessionHeartbeatOptions {
  workspaceRoot: string;
  sessionKey: string;
  fs?: HeartbeatFs;
}

export class SessionHeartbeat {
  private readonly workspaceRoot: string;
  private readonly sessionKey: string;
  private readonly fs: HeartbeatFs;
  private readonly filePath: string;

  private turnId = "";
  private iteration = 0;
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: SessionHeartbeatOptions) {
    this.workspaceRoot = opts.workspaceRoot;
    this.sessionKey = opts.sessionKey;
    this.fs = opts.fs ?? REAL_FS;
    this.filePath = SessionHeartbeat.heartbeatPath(
      opts.workspaceRoot,
      opts.sessionKey,
    );
  }

  /** Canonical path for a session's heartbeat file. */
  static heartbeatPath(workspaceRoot: string, sessionKey: string): string {
    // Sanitise sessionKey for filesystem safety
    const safe = sessionKey.replace(/[^a-zA-Z0-9_:.-]/g, "_");
    return path.join(
      workspaceRoot,
      "core-agent",
      "sessions",
      safe,
      "heartbeat.json",
    );
  }

  /** Begin heartbeat writes. Writes immediately, then every 10s. */
  async start(turnId: string, iteration: number): Promise<void> {
    if (this.running) return;
    this.turnId = turnId;
    this.iteration = iteration;

    // Ensure directory exists
    const dir = path.dirname(this.filePath);
    await this.fs.mkdir(dir);

    // Immediate first write — set running AFTER success so a failed
    // start() leaves the instance in a clean idle state.
    await this.writeFile(true);
    this.running = true;

    // Periodic writes
    this.timer = setInterval(() => {
      void this.tick();
    }, HEARTBEAT_FILE_INTERVAL_MS);
    if (typeof (this.timer as { unref?: () => void }).unref === "function") {
      (this.timer as { unref: () => void }).unref();
    }
  }

  /** Update the current iteration counter. */
  updateIteration(iter: number): void {
    this.iteration = iter;
  }

  /** Stop heartbeat — writes final alive:false entry. Idempotent. */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    try {
      await this.writeFile(false);
    } catch {
      /* best-effort */
    }
  }

  /** Read a session's heartbeat file. Returns null if missing/corrupt. */
  static async readHeartbeat(
    workspaceRoot: string,
    sessionKey: string,
    fs?: HeartbeatFs,
  ): Promise<HeartbeatFileData | null> {
    const f = fs ?? REAL_FS;
    const filePath = SessionHeartbeat.heartbeatPath(workspaceRoot, sessionKey);
    try {
      const raw = await f.readFile(filePath);
      return JSON.parse(raw) as HeartbeatFileData;
    } catch {
      return null;
    }
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    try {
      await this.writeFile(true);
    } catch {
      /* best-effort — never crash the turn */
    }
  }

  private async writeFile(alive: boolean): Promise<void> {
    const now = Date.now();
    const data: HeartbeatFileData = {
      alive,
      sessionKey: this.sessionKey,
      turnId: this.turnId,
      iteration: this.iteration,
      lastActivityMs: now,
      updatedAt: new Date(now).toISOString(),
      ...(!alive ? { completedAt: new Date(now).toISOString() } : {}),
    };
    await this.fs.writeFile(this.filePath, JSON.stringify(data));
  }
}

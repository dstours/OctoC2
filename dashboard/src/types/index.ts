// dashboard/src/types/index.ts
// Central re-export — consumers use: import { Beacon, Task } from '@/types'

export type { Beacon, BeaconStatus, ServerBeaconStatus, OS, Arch, TentacleId } from './beacon';
export { TENTACLE_NAMES } from './beacon';

export type { Task, TaskKind, TaskStatus } from './task';

export type { TaskResult, DecryptedResult, DecryptResult } from './result';

export type {
  ConnectionMode,
  TentacleHealth,
  ApiResponse,
  ApiError,
} from './connection';

export type {
  GitHubIssue,
  GitHubLabel,
  GitHubUser,
  GitHubComment,
  GitHubGist,
  GitHubGistFile,
} from './github';

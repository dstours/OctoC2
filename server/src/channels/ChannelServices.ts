import type { ChannelId, CheckinPayload, TaskResult } from "@octoc2/shared";
import type {
  CompleteTaskResultResult,
  OctoStore,
  TaskResultSource,
} from "../store/index.ts";
import type { TaskQueue } from "../TaskQueue.ts";
import { RejectedArtifactError } from "../services/ArtifactErrors.ts";
import {
  checkinAuthorizesTaskDelivery,
  type CheckinVerificationStatus,
} from "../services/BeaconIdentityService.ts";

export { RejectedArtifactError } from "../services/ArtifactErrors.ts";
export { checkinAuthorizesTaskDelivery };

export interface ChannelIdentityService {
  verifyAndRegisterCheckin(
    payload: CheckinPayload,
    authenticatedBeaconId: string,
    tentacleId: ChannelId,
    issueNumber?: number,
  ): Promise<CheckinVerificationStatus>;
}

export interface ChannelTaskService {
  acceptSignedResult(
    result: TaskResult,
    authenticatedBeaconId: string,
    source?: TaskResultSource,
  ): Promise<CompleteTaskResultResult>;
}

export interface SecureChannelServices {
  store: OctoStore;
  identities: ChannelIdentityService;
  tasks: ChannelTaskService;
  queue?: TaskQueue;
}

export function parseCheckinPayload(serialized: string): CheckinPayload {
  const parsed: unknown = JSON.parse(serialized);
  if (!isRecord(parsed)) throw new Error("checkin payload must be an object");
  for (const key of [
    "beaconId",
    "publicKey",
    "hostname",
    "username",
    "os",
    "arch",
    "checkinAt",
  ]) {
    if (typeof parsed[key] !== "string" || !parsed[key]) {
      throw new Error(`checkin payload is missing ${key}`);
    }
  }
  if (
    typeof parsed["pid"] !== "number" ||
    !Number.isSafeInteger(parsed["pid"]) ||
    parsed["pid"] < 0
  ) {
    throw new Error("checkin payload has an invalid pid");
  }
  if (!isRecord(parsed["identity"])) {
    throw new Error("signed checkin identity is required");
  }
  return parsed as unknown as CheckinPayload;
}

export function parseTaskResult(serialized: string): TaskResult {
  const parsed: unknown = JSON.parse(serialized);
  if (!isRecord(parsed)) throw new Error("task result must be an object");
  if (
    typeof parsed["taskId"] !== "string" ||
    !parsed["taskId"] ||
    typeof parsed["beaconId"] !== "string" ||
    !parsed["beaconId"] ||
    typeof parsed["success"] !== "boolean" ||
    typeof parsed["output"] !== "string" ||
    typeof parsed["completedAt"] !== "string" ||
    typeof parsed["signature"] !== "string" ||
    !parsed["signature"]
  ) {
    throw new Error("complete signed task result is required");
  }
  return parsed as unknown as TaskResult;
}

export function assertAcceptedResult(
  outcome: CompleteTaskResultResult,
): "accepted" | "duplicate" {
  if (outcome.status === "completed") return "accepted";
  if (outcome.status === "exact_duplicate") return "duplicate";
  throw new RejectedArtifactError(
    `task result rejected: ${outcome.status}`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

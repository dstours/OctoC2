import type { QueuedTask } from "../TaskQueue.ts";
import {
  DurablePollState,
  PollRunner,
  repositoryPollScope,
  type DurableArtifactOutcome,
  type DurableProcessingResult,
} from "../lib/PollRunner.ts";
import type {
  DeliveryLease,
  ProcessedChannelMessage,
} from "../store/index.ts";
import {
  RejectedArtifactError,
  type SecureChannelServices,
} from "./ChannelServices.ts";

export type { SecureChannelServices } from "./ChannelServices.ts";

export interface ChannelArtifact {
  messageId: string;
  payload: string;
  cursor: string;
  beaconId?: string;
  taskId?: string;
}

export interface ClaimedDelivery {
  task: QueuedTask;
  lease: DeliveryLease;
}

export interface ProcessedChannelArtifact<T> extends DurableArtifactOutcome {
  outcome: ProcessedChannelMessage["outcome"];
  value?: T;
}

export function createChannelRunner(
  name: string,
  intervalMs: number,
  poll: () => Promise<void>,
): PollRunner {
  return new PollRunner({
    name,
    intervalMs,
    poll,
    onError: (error) => {
      console.warn(
        `[${name}] Poll error:`,
        error instanceof Error ? error.message : String(error),
      );
    },
  });
}

export function createRepositoryPollState(
  services: SecureChannelServices,
  channel: string,
  owner: string,
  repo: string,
): DurablePollState {
  return new DurablePollState(
    services.store,
    channel,
    repositoryPollScope(owner, repo),
  );
}

/**
 * Decode and accept one immutable channel artifact under durable progress.
 *
 * Decoder failures and explicit RejectedArtifactError failures are permanent
 * poison-artifact outcomes and are committed once as rejected. Ordinary
 * errors from GitHub, identity/task services, or SQLite escape the handler,
 * leaving both the message and cursor uncommitted for a later retry.
 */
export async function processIncomingArtifact<T>(
  services: SecureChannelServices,
  state: DurablePollState,
  artifact: ChannelArtifact,
  description: string,
  decode: () => T | Promise<T>,
  accept: (
    value: T,
  ) => void | DurableProcessingResult | Promise<void | DurableProcessingResult>,
): Promise<ProcessedChannelArtifact<T>> {
  let value: T | undefined;
  let rejectionReason: string | undefined;
  let handledOutcome: ProcessedChannelMessage["outcome"] | undefined;
  const durable = await state.process(artifact, async () => {
    try {
      value = await decodeRejectedArtifact(description, decode);
      const result = await accept(value);
      handledOutcome = result?.outcome ?? "accepted";
      return result;
    } catch (error) {
      if (!(error instanceof RejectedArtifactError)) throw error;
      rejectionReason = error.message;
      handledOutcome = "rejected";
      return { outcome: "rejected" };
    }
  });
  const persisted = durable.status === "processed"
    ? undefined
    : services.store.getProcessedMessage(
      state.channel,
      artifact.messageId,
    );
  const outcome = handledOutcome ?? persisted?.outcome;
  if (!outcome) {
    throw new Error(
      `durable channel outcome is missing for ${state.channel}:${artifact.messageId}`,
    );
  }

  if (rejectionReason) {
    console.warn(
      `[${state.channel}] Rejected ${artifact.messageId}: ${rejectionReason}`,
    );
  }

  if (
    durable.status === "exact_duplicate" &&
    outcome !== "rejected"
  ) {
    value = await decodeRejectedArtifact(description, decode);
  }

  return {
    status: durable.status,
    outcome,
    ...(value !== undefined && { value }),
  };
}

export function rejectArtifact(message: string): never {
  throw new RejectedArtifactError(message);
}

async function decodeRejectedArtifact<T>(
  description: string,
  decode: () => T | Promise<T>,
): Promise<T> {
  try {
    return await decode();
  } catch (error) {
    if (error instanceof RejectedArtifactError) throw error;
    throw new RejectedArtifactError(
      `${description}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export function claimDeliveries(
  services: SecureChannelServices,
  channel: string,
  beaconId: string,
  tasks: readonly QueuedTask[],
  leaseDurationMs: number,
): ClaimedDelivery[] {
  const claimed: ClaimedDelivery[] = [];
  for (const task of tasks) {
    const outcome = services.store.claimDelivery({
      taskId: task.taskId,
      beaconId,
      channel,
      workerId: `server:${channel}`,
      leaseDurationMs,
    });
    if (outcome.status === "claimed") {
      claimed.push({ task, lease: outcome.lease });
    }
  }
  return claimed;
}

export function finishDeliveries(
  services: SecureChannelServices,
  deliveries: readonly ClaimedDelivery[],
  outcome: "delivered" | "transient_failure" | "permanent_failure",
  error?: unknown,
): void {
  const message = error instanceof Error ? error.message : (
    error === undefined ? null : String(error)
  );
  for (const delivery of deliveries) {
    const finished = services.store.finishDelivery({
      leaseToken: delivery.lease.leaseToken,
      outcome,
      ...(message !== null && { error: message }),
    });
    if (finished) services.queue?.refreshFromStore(delivery.task.taskId);
  }
}

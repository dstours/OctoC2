# Channel Guide

OctoC2 calls each communication implementation a **tentacle**. All selectable
tentacles carry the canonical signed and encrypted task protocol; they differ
in artifact type, authentication, latency, and operational prerequisites.

> [!IMPORTANT]
> **Authorized use only.** Enable a channel only across repositories, accounts,
> networks, and endpoints included in the approved test boundary.

## Status vocabulary

| Status | Meaning |
|---|---|
| Implemented | Complete implant and controller counterparts are present and covered by repository tests |
| Selectable | Runtime code exists, but successful use depends on explicit environment, identity, network, or external-service qualification |
| Unavailable | Reserved identifier; runtime selection is rejected |

Selectable does not mean live-qualified in every environment. Use the
[traceability record](REMEDIATION_TRACEABILITY.md) to distinguish local tests,
integration tests, and live task/result evidence for the exact revision.

## Catalog

| ID | Kind | Path | Status | Principal prerequisites |
|---:|---|---|---|---|
| 1 | `issues` | GitHub issue comments | Implemented | Metadata read, Issues read/write, operator public key |
| 2 | `branch` | Per-beacon branch/files | Implemented | Metadata read, Contents read/write, default branch, operator public key |
| 3 | `actions` | Dispatch + Actions variables | Implemented | Metadata read, Actions and Variables read/write, operator public key |
| 4 | `codespaces` | gRPC over Codespaces SSH | Selectable | gRPC/mTLS, beacon bearer, SSH, user Codespaces token |
| 5 | `pages` | Deployments/statuses | Selectable | Metadata read, Deployments read/write, default branch |
| 6 | `gist` | Secret Gists | Implemented | Two distinct `gist` PATs for one dedicated account |
| 7 | `oidc` | HTTPS with Actions OIDC | Selectable | Actions `id-token: write`, HTTPS/TLS, exact claims binding |
| 7b | `secrets` | Actions variables | Selectable | Metadata read, Variables read/write, operator public key |
| 8 | `pull_request` | Reserved PR+SSH path | Unavailable | Not selectable |
| 9 | `stego` | LSB payload in PNG files | Selectable | Metadata read, Contents read/write, default branch |
| 10 | `proxy` | Signed control/decoy relay | Selectable | Distinct private decoy repo, Issues transport, signed route |
| 11 | `notes` | Git Notes refs | Implemented | Metadata read, Contents read/write, operator public key |
| 12 | `relay` | Authenticated gRPC/SSH consortium | Selectable | Signed relay config, gRPC/mTLS, bearer, optional SSH discovery |
| 13 | `http` | Direct HTTPS/WebSocket | Selectable | Opt-in HTTPS listener, trusted server certificate, beacon bearer |

## Repository-backed channels

### Issues

Issues publishes encrypted tasks and results as comments. Install the App or
scope fine-grained tokens to the control repository with Metadata read and
Issues read/write. Set the `MONITORING_PUBKEY` Actions variable. A `404` often
means the token cannot see the private repo or the referenced issue was removed;
a `403` usually indicates permission or policy denial.

### Branch

Branch stores per-beacon transport files on a dedicated branch. It requires
Contents read/write and a resolvable default branch. The implementation can
bootstrap a missing transport branch; protection rules must still permit the
configured identity to write the transport paths.

### Actions

Actions combines repository dispatch with Actions variables. Grant both
Actions read/write and Variables read/write. Repository dispatch is accepted
only when sent to the exact configured repository; workflow permissions and
organization policy can still block it.

### Pages

Pages uses GitHub deployments and deployment statuses, not a public Pages site.
Grant Deployments read/write and ensure the repository has a default branch.
No public website needs to be enabled.

### Secrets (`7b`)

The historical channel name is `secrets`, but its transport uses Actions
**variables**, not repository secret values. Grant Variables read/write. Do not
put transport ciphertext in Actions secrets under the assumption that this
channel reads them.

### Steganography

Stego embeds encrypted payload bytes in PNG files and commits them through the
Contents API. It requires the same repository and key prerequisites as Branch.
Verify that security tooling, image optimization, or mirroring does not rewrite
the PNG, because byte transformation destroys the embedded payload.

### Git Notes

Notes writes encrypted records under Git Notes refs using Contents access. Repo
mirrors and cleanup jobs do not always preserve notes refs; include those refs
in backup and cleanup procedures.

## User-level GitHub channels

### Gists

Gist uses secret Gists belonging to one dedicated GitHub account. Configure two
different classic PATs with `gist`: one on the controller and one on the
beacon. The repository App installation lease is not used. Remove test Gists
after a live qualification, but retain or revoke the PATs only according to the
operator's credential cleanup decision.

### Codespaces

Codespaces discovers an approved Codespace through the GitHub API and opens an
SSH tunnel to the controller's gRPC listener. It requires:

- a classic PAT with `codespace` for the account that can access the named
  Codespace;
- GitHub CLI authentication and SSH connectivity;
- gRPC server CA/certificate/key;
- a unique client certificate and exact fingerprint binding for the beacon;
- a per-beacon bearer credential.

Direct gRPC can be used without Codespaces discovery by setting
`SVC_GRPC_DIRECT`. Codespaces never falls back to a repository App lease for its
user-level API.

## Direct channels

### HTTP

HTTP uses the controller's opt-in HTTPS/WebSocket listener. Configure a server
certificate whose SAN covers the hostname in `SVC_HTTP_URL`, install the CA in
the beacon trust path, and give the beacon its exact bearer token. Credentials
are accepted in headers, not URLs. There is no plaintext or certificate-bypass
mode.

### OIDC

OIDC is intended for GitHub Actions jobs. The workflow requests
`id-token: write`, obtains an identity token for the configured audience, and
connects to the HTTPS controller. The controller binding must match repository,
beacon ID, subject, and workflow ref exactly; empty lists and wildcards are
rejected. OIDC proves the workflow identity and does not broaden task or result
ownership.

### Relay

Relay uses an explicitly provisioned consortium route over authenticated gRPC
and optional SSH discovery. Each hop must satisfy the same mTLS, bearer, and
identity requirements as direct gRPC. Relay configuration is signed; discovery
data is not itself task authority.

## Proxy channel

Proxy wraps the Issues channel in a signed two-repository route. The beacon
interacts with a private decoy repository; a workflow relays envelopes to the
private control repository and returns results. Provision both sides with
`octoctl proxy create` or `proxy provision`, then follow the [proxy workflow
contract](../templates/proxy/README.md).

The control and decoy repositories must be different. Use exact repository
bindings, distinct dispatch credentials, signed envelopes, and route-level
deduplication. A proxy test is complete only after the live result is accepted
and relay artifacts are cleaned from both repositories.

## Selection and failover

Set a comma-separated priority list:

```text
SVC_TENTACLE_PRIORITY=issues,branch,actions,http
```

Unknown and unavailable channel names are logged and ignored; if none remain,
the beacon falls back to Issues. Configure every listed channel completely and
review startup logs for ignored entries. `ConnectionFactory` selects healthy
channels in order, classifies failures, and retries or fails over according to
channel policy.

Inspect configuration and health with:

```bash
octoctl tentacles list
octoctl tentacles health <beacon-id>
```

Force a specific route for an authorized qualification:

```bash
octoctl task <beacon-id> --kind ping --tentacle notes
octoctl results <beacon-id> --last 1
```

A successful registration alone is not channel qualification. Record encrypted
task publication, beacon receipt, signed result publication, controller
acceptance, and artifact cleanup through the same named channel.

## Choosing a channel

| Need | Prefer |
|---|---|
| Simplest private-repo baseline | Issues |
| Repository path without issue artifacts | Branch or Git Notes |
| GitHub Actions integration | Actions or OIDC |
| No control-repo visibility at the endpoint | Proxy with a distinct decoy repo |
| Low-latency private network path | HTTPS or direct gRPC |
| Gist-only user surface | Gist with dedicated credentials |
| Recovery after normal credentials fail | Signed recovery record, then the recovered eligible channel |

Choose the least-complex channel that satisfies the approved test boundary.
Adding channels increases credentials, permissions, artifacts, and cleanup
obligations.

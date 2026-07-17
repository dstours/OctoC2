# Remediation Traceability

> [!IMPORTANT]
> **Authorized use only.** This document records implementation, verification,
> live qualification, and cleanup evidence for explicitly approved test
> environments.

This matrix maps the security findings and execution phases to their local
remediation. “Verified” means the corresponding deterministic local test or
policy check passed. Live external evidence is recorded separately below.

## Phase traceability

| Phase | Resolved outcome | Principal implementation | Verification evidence |
|---|---|---|---|
| A — Fail-closed containment | HTTP and gRPC are opt-in and loopback-bound by default; operator, beacon, and GitHub credentials are separate; WebSocket credentials use headers and are revalidated after upgrade; malformed beacon timing configuration is rejected; unsigned modules are rejected and their executable/storage implementation is removed; public surfaces carry a warning. | `server/src/config/RuntimeConfig.ts`, `server/src/index.ts`, `server/src/services/CredentialVerifier.ts`, `implant/src/index.ts`, `implant/src/tentacles/HttpTentacle.ts`, `implant/src/tasks/TaskExecutor.ts`, `octoctl/src/index.ts`, dashboard task controls, public documentation | Runtime configuration, HTTP authorization and WebSocket revocation/expiry, implant configuration, gRPC authorization/TLS, TaskExecutor, CLI, dashboard, documentation consistency, and policy tests |
| B — Shared protocol and identity | One shared task catalog, channel catalog, canonical JSON/signature format, Ed25519 beacon identity, versioned state migration, pre-enrollment, and generated proto source are used across workspaces. Baked/provisioned beacon IDs must be canonical lowercase UUIDs. Existing security state is validated strictly; corrupt, mismatched, unknown-version, or ambiguous state cannot silently create a new identity. | `shared/src/`, `implant/src/state/BeaconState.ts`, `implant/src/index.ts`, `octoctl/src/commands/buildBeacon.ts`, `server/src/services/EnrollmentLoader.ts`, `proto/svc.proto`, `scripts/generate-proto.ts` | Shared contract tests, canonical build-ID rejection, strict state-load and beacon-ID resolution tests, build-beacon tests, enrollment/identity tests, proto clean-generation check, all workspace type checks |
| C — Transactional state and authorization | SQLite with migrations, WAL, foreign keys, busy timeout, durable beacons/keys/hashed credentials/tasks/results/leases/messages/cursors, one-time legacy import, and central identity/task services replace trust in channel-local state. | `server/src/store/`, `server/src/services/BeaconIdentityService.ts`, `server/src/services/TaskService.ts`, `server/src/BeaconRegistry.ts`, `server/src/TaskQueue.ts` | Store migration/restart tests, identity tests, credential tests, queue/result ownership and idempotency tests |
| D — gRPC security | The server requires mTLS client certificates and a per-beacon bearer credential; a unique configured certificate fingerprint binds the TLS peer to that bearer principal before any mutation; the implant supplies CA/client material and metadata; principal, beacon ID, identity, and task ownership are bound; result metadata and optional empty-data presence are preserved canonically end to end. | `server/src/grpc/BeaconGrpcService.ts`, `implant/src/tentacles/grpc/BeaconGrpcClient.ts`, `implant/src/tentacles/GrpcSshTentacle.ts`, `proto/svc.proto` | Real local CA/server/two-client TLS integration, certificate-A/token-B rejection, missing/wrong credential tests, canonical result-metadata/data-presence tests, implant mTLS client tests, port lifecycle tests |
| E — App auth and recovery | GitHub App private keys remain server-only; short, repository-scoped installation-token leases are minted centrally; deterministic public recovery objects are signed, sealed, generation-bound, expiring, and applied atomically; renewal is proactive. Persisted version-2 recovery state retains the signed outer expiry, while expired or legacy credentials are ignored without rolling back the highest accepted generation and rotated signer. | `server/src/services/GitHubInstallationTokenService.ts`, `server/src/services/RecoveryPublisherService.ts`, `implant/src/lib/GitHubTokenProvider.ts`, `implant/src/recovery/`, `docs/RECOVERY.md` | Installation-token scope/expiry tests, signed recovery publication and tamper/staleness tests, token-provider injection tests, outer-expiry, trust-ratchet, rollback, and recovery application tests |
| F — Channel and proxy correctness | Branch and Stego bootstrap from the actual default branch and use bounded non-forced optimistic Git retries that rebase on the latest tree; server Stego and Pages counterparts are wired; catalogs agree; ACK-backed channels publish a fresh signed check-in each cycle instead of treating retained routing artifacts as authority; Issues keeps its machine-readable signed CI check-in current alongside the maintenance comment and uses an explicit exact-registration ACK; proxy ingress/egress uses distinct repositories, signed dispatches, route binding, event-scoped serialization, and stable deduplication markers. | `server/src/channels/`, `implant/src/tentacles/`, `shared/src/channels.ts`, `templates/proxy/`, `octoctl/src/commands/proxy.ts` | First-use and create/update/delete race tests for Branch/Stego, Pages tests, signed per-cycle check-in and retained-routing rejection tests, explicit ACK tests, proxy workflow parser/policy tests |
| G — Polling, idempotency, and crash safety | Polls cannot overlap; cursors and processed message IDs advance transactionally; mutable Actions/Secrets/Gist message IDs include the payload digest so same-timestamp edits remain distinct; every transport uses exclusive delivery leases; duplicate or stale check-ins cannot authorize new task claims; results are idempotent. OIDC durably binds each JTI to one payload, atomically caches the exact response with delivery finalization, preserves bindings across aborts, and prunes only after safe lease/token boundaries. The implant distinguishes artifact write from authenticated controller acceptance, retries cached unacknowledged results, and applies kill/sleep/self-delete directives only after acceptance is persisted. A bounded detailed ledger plus append-only seen-task filter prevents execution after detail eviction and fails closed on replay-state uncertainty. | `server/src/lib/PollRunner.ts`, `server/src/channels/ChannelRuntime.ts`, `server/src/TaskQueue.ts`, `server/src/BeaconRegistry.ts`, `server/src/http/OidcRoutes.ts`, `server/src/store/OctoStore.ts`, `shared/src/tasks.ts`, `implant/src/state/BeaconState.ts`, `implant/src/state/SeenTaskFilter.ts`, `implant/src/tasks/TaskLifecycle.ts`, `implant/src/tentacles/IssuesTentacle.ts` | Poll non-overlap/retry tests, same-tick mutable-artifact identity and durable cursor/dedup tests, competing-transport lease tests, duplicate-check-in no-delivery tests, OIDC concurrent/cache/conflict/abort/sweep tests, authenticated result-receipt tests, restart resubmission and directive crash-window tests, task-ledger eviction/filter/corruption tests, lifecycle transition tests |
| H — Assurance and documentation | CI runs deterministic unprivileged checks on pushes and pull requests; live-secret E2E is manual and fail-closed; versions and Actions are pinned; dependency, docs, workflow, toolchain, proto, lint, audit, test, type, build, and smoke checks are defined. | `.github/workflows/`, root policy scripts, pinned workspace manifests, README and docs, `scripts/test-end-to-end.ts` | Frozen install, policy checks, full workspace suites, strict type checks, ESLint, audit, generated-proto check, all builds, implant target builds, smoke checks |

## Security invariant coverage

| Invariant | Local evidence |
|---|---|
| Default startup exposes no direct controller listener; enabled HTTP is encrypted. | `RuntimeConfig.test.ts` verifies both listeners disabled with loopback defaults and required HTTP certificate paths; `DashboardHttpServer.test.ts` exercises the TLS listener and proves plaintext HTTP is refused. |
| GitHub, operator API, and per-beacon API credentials cannot substitute for one another. | Server startup rejects equality; HTTP and gRPC negative authorization tests cover wrong roles and principals; persisted credentials are hashed and revocable. |
| Revoking or expiring a credential terminates an existing WebSocket session. | `DashboardHttpServer.test.ts` upgrades with a valid credential, then proves both durable revocation and expiry fail closed on the next message. |
| A beacon cannot replace another beacon’s key or complete its task. | Enrollment/key-binding checks and central task ownership transactions reject replacement and wrong-owner results. |
| Unsigned, tampered, replayed, or conflicting messages cannot mutate accepted state. | Shared signature verification, channel processed-message transactions, result duplicate semantics, durable payload-bound OIDC JTI reservations, cached-response recovery, and conflict handling are tested. |
| Competing transports cannot deliver the same task simultaneously. | SQLite delivery leases and direct HTTP/gRPC/OIDC plus GitHub-channel claim tests cover exclusivity and retry release. |
| A duplicate or stale signed check-in cannot claim newly queued tasks. | Identity verification classifies exact duplicates without refreshing liveness; direct and GitHub channel tests prove that only accepted or forward-gap sequences authorize new delivery. Durable GitHub channels additionally require a fresh per-cycle artifact newly processed in the current poll; retained routing artifacts carry no delivery authority. Repeating one completed OIDC request with the same JTI returns its cached response rather than making a new claim; Issues may re-emit only its encrypted non-task registration acknowledgement. |
| Writing a result artifact is not sufficient authority for a destructive directive. | Direct transports require an authenticated accepted response. Issues and the Issues-backed proxy require an operator-authenticated encrypted receipt bound to the exact signed result digest. Other asynchronous channels leave the result and directive unacknowledged. |
| Controller acceptance and directive effects survive process interruption. | Cached signed results are resubmitted after restart and on later loops until accepted; unresolved result/directive lifecycle blocks new check-ins and task execution while proactive credential recovery remains available; kill and sleep effects are persisted before use, self-delete is marked only after successful removal, and startup resumes an accepted but unapplied directive. |
| Redelivery cannot execute a previously seen task after detailed history is evicted. | The 256-entry detailed ledger retains all nonterminal safety state, while a persisted append-only seen-task filter remembers evicted accepted task IDs. Filter matches and uncertain migration/corruption cases refuse execution. |
| Corrupt or ambiguous security state cannot silently reset identity or replay protection. | State-load and beacon-ID resolution tests reject malformed or unknown-version state, identity mismatches, invalid ledger/filter data, simultaneous primary/fallback files, and orphaned sidecar artifacts. |
| Expired recovery credentials cannot roll trust backward. | Version-2 outer expiry and all contained leases gate configuration reuse, while the highest accepted generation and rotated signing key are restored even from expired version-2 or trust-only legacy version-1 state. |
| No beacon receives a GitHub App private key. | Build/setup reject legacy App-key input; only server policy reads private-key files; compiled-artifact and source scans are part of final verification. |
| Remote module execution has no bypass. | `load-module` is absent from the shared catalog and dashboard, rejected by server/CLI/implant, and the old loader, sample payloads, and server module store are removed. |

## Deliberately unclaimed external evidence

## Authorized live qualification evidence

An explicitly authorized run on 2026-07-17 used dedicated private control and
decoy repositories and role-separated credentials. No repository coordinates,
credential values, beacon identifiers, task identifiers, or operator identity
are retained in source. The guarded local harnesses recorded these outcomes:

- Issues, Branch, Actions, Pages, Gist, Secrets, Stego, and Notes each completed
  registration, encrypted ping delivery, implant receipt, signed result
  publication, and controller acceptance.
- Direct HTTPS/WebSocket completed compiled-beacon registration, encrypted ping
  delivery, and signed result acceptance using an ephemeral CA and certificate.
- The two-repository proxy completed signed ingress and egress relay.
- A GitHub-hosted Actions runner issued an OIDC token whose live signature and
  provenance claims were verified without logging or retaining the token.
- A disposable Codespace completed SSH service discovery and port forwarding;
  relay discovery failed over from an unavailable candidate and reused the
  authenticated live relay.

The reusable guarded harnesses are `scripts/test-live-github-channels.ts`,
`scripts/test-live-host.ts`, `scripts/test-live-http-host.ts`,
`scripts/test-live-proxy.ts`, `scripts/test-live-oidc.ts`, and
`scripts/test-live-codespaces.ts`. Their final audits reported no remaining test
branches, Git refs, variables, secrets, deployments, environments, issues,
workflow runs, Codespaces, local processes, temporary directories, embedded
credential values, or personal identifiers. Credentials were not revoked or
deleted.

These results do not replace longer-running rate-limit, response-loss, restart,
capacity, certificate-lifecycle, or independent security validation. The
protected manual E2E workflow remains a prerequisite validator and does not
perform these guarded live runs automatically.

Cryptographic signing, sealing, replay checks, and authenticated result
receipts do not create a repository-level privilege boundary. A credential
with broad write access to a repository shared by controller and beacon
traffic may still delete, delay, reorder, or deny access to artifacts even
when it cannot forge their authenticated contents. Stronger operational
separation still requires distinct repositories, accounts, and
least-privilege credentials.

# Operations and Assurance

> [!IMPORTANT]
> **Authorized use only.** Apply these controls to systems and repositories you
> own or have explicit permission to test. Keep credentials scoped, listeners
> private, and certificates trusted by every participating client.

## Recommended operating baseline

Begin with the following baseline:

- private, disposable GitHub repositories;
- least-privilege credentials created for the evaluation;
- listeners disabled by default;
- loopback binding unless an explicitly reviewed private test network requires
  otherwise;
- TLS and per-beacon authentication for gRPC;
- separate controller-to-GitHub, operator, beacon, and direct-dashboard
  credentials;
- local tests and type checks before use;
- manually approved live-secret E2E.

## Assurance boundaries

Plan explicitly for GitHub API and policy changes, shared-repository privilege
limits, denial of access to transport artifacts, certificate rotation, and
independent review of the deployment environment. Do not expose controller
listeners publicly or treat a shared repository as a multi-tenant security
boundary.

GitHub repository permissions remain a meaningful architectural limit. A token
with broad write access to the shared repository may affect data consumed by
multiple components. Use separate repositories and accounts where stronger
separation is required. Signatures, encryption, replay checks, and result
acceptance receipts protect authenticity and integrity; they do not prevent a
broad repository writer from deleting, delaying, reordering, or denying access
to artifacts.

## Listener policy

HTTP and gRPC are opt-in:

| Listener | Enable flag | Default host | Default port | Additional requirements |
|---|---|---:|---:|---|
| HTTPS/WSS/REST/SSE | `OCTOC2_HTTP_ENABLED=true` | `127.0.0.1` | `8080` | Server certificate/key, operator token, and per-beacon token map |
| gRPC | `OCTOC2_GRPC_ENABLED=true` | `127.0.0.1` | `50051` | Per-beacon token and client-certificate fingerprint maps plus TLS material |
| Dashboard dev server | explicit `bun run dev` | `127.0.0.1` | `5173` | Trusted local browser |

Codespaces port forwarding does not make a listener safe. Keep forwarded ports
private and start each process explicitly.

## Credential boundaries

Use a unique value for each role:

| Role | Variable or UI field | Allowed use |
|---|---|---|
| Server GitHub credential | `OCTOC2_SERVER_GITHUB_TOKEN` | GitHub API calls made by the controller |
| Server Gist credential | `OCTOC2_SERVER_GIST_TOKEN` | Optional Gist polling with a dedicated, role-separated token |
| Operator API token | `OCTOC2_OPERATOR_API_TOKEN` | Operator REST/SSE routes |
| Beacon API tokens | `OCTOC2_BEACON_API_TOKENS` | Authenticated beacon HTTP/gRPC routes |
| Direct dashboard PAT | Dashboard “GitHub PAT” field | Direct GitHub API fallback only |
| Operator encryption secret | `OCTOC2_OPERATOR_SECRET` | Cryptographic task/result operations |

The controller rejects known credential-role collisions. Operational procedures
must still prevent reuse outside the process.

Gist is disabled unless `OCTOC2_SERVER_GIST_TOKEN` is set. The controller and
beacon must use distinct Gist-capable tokens belonging to the same dedicated
GitHub account; the beacon receives its token as `SVC_GIST_TOKEN`. Gist never falls back to the repository credential or an App
installation lease.

`OCTOC2_BEACON_API_TOKENS` must be a JSON object keyed by each full,
pre-enrolled beacon ID. Store only random per-beacon values there; the matching
beacon receives its value as `SVC_BEACON_API_TOKEN`.

WebSocket authentication is revalidated against the durable credential store
for every message. Revoking or expiring a credential therefore closes an
already-upgraded session instead of allowing it to remain authenticated.

## Lifecycle and retention

The controller runs a local lifecycle sweep every
`OCTOC2_LIFECYCLE_INTERVAL_MS` (default 60 seconds). The following positive
integer millisecond values may be tuned conservatively:

| Variable | Default | Effect |
|---|---:|---|
| `OCTOC2_BEACON_DORMANT_AFTER_MS` | 10 minutes | Changes an inactive beacon from `active` to `dormant` |
| `OCTOC2_BEACON_LOST_AFTER_MS` | 24 hours | Changes a sufficiently old beacon to `lost`; must exceed the dormant threshold |
| `OCTOC2_PROCESSED_MESSAGE_RETENTION_MS` | 30 days | Deletes eligible non-OIDC processed-message deduplication records older than the retention window |

The same sweep expires tasks and revokes expired credentials. Invalid,
non-positive, unsafe, or inverted threshold values stop startup.

Signed check-ins also have bounded freshness. The default
`OCTOC2_CHECKIN_MAX_AGE_MS` is 30 minutes and the default
`OCTOC2_CHECKIN_MAX_FUTURE_SKEW_MS` is 5 minutes. Increase the age only when a
documented GitHub propagation window requires it; captured older check-ins are
rejected even when their sequence has not previously been observed.

## Check-in replay and OIDC request durability

Only a newly accepted signed check-in, including an accepted forward sequence
gap, may authorize a new task-delivery claim. An exact duplicate or a stale
exact duplicate is authenticated and classified for recovery purposes, but it
does not refresh liveness, change the active channel, or receive tasks that
were queued after the original request.

Durable GitHub polling adds a second gate: only an artifact newly marked
`processed` in the current poll may emit a task or acknowledgement artifact.
An exact replay already present in durable deduplication state cannot authorize
another delivery.

ACK-backed GitHub channels publish a fresh signed check-in artifact on every
beacon cycle. Retained branch, note, variable, file, or other routing artifacts
may help locate a return path, but they are never delivery authority. The
server requires the current artifact to be both newly processed and classified
as `accepted` or `gap`.

For mutable Actions, Secrets, and Gist acknowledgements, the durable message
identity includes a SHA-256 payload digest in addition to the GitHub
timestamp or Gist ID. Two valid edits with the same reported timestamp
therefore remain distinct, while an exact edit replay remains deduplicated.

Branch and Steganography Git updates and deletes use bounded optimistic
retries with non-forced ref writes. Each retry reloads and rebases on the
latest tree; branch-creation 409/422 races retry against the winning ref
instead of overwriting it.

Issues follows the same rule while retaining its operator-facing maintenance
comment: every cycle creates or updates a machine-readable signed CI check-in
comment for server processing. The maintenance comment is presentation and
diagnostic state only; it cannot authorize task delivery.

OIDC adds a durable request layer around that rule:

- Before processing, SQLite binds the JWT `jti` to the repository, beacon,
  token expiry, and a digest of the complete authorized request.
- Concurrent retries of the same binding wait briefly for the owner, receive
  the exact cached HTTP status, headers, and body after completion, or receive
  a retryable 503 while the same request is still processing.
- Reusing a `jti` with a different binding is a conflict and returns HTTP 409.
- A transient abort transactionally releases task-delivery leases and fences
  the failed owner, but retains the immutable `jti` binding so only the same
  payload can retry. If cleanup itself fails, the processing and delivery
  leases remain time-bounded.
- Task-delivery finalization and response caching commit in the same
  transaction.
- A completed request is not pruned until both the retention cutoff and the
  JWT's own expiry have passed. An abandoned processing request is removed
  only after both its processing lease and JWT have expired.
- Legacy OIDC replay records do not contain a trustworthy token expiry, so
  they remain retained fail-closed.

Replaying the same completed OIDC request with the same `jti` can therefore
return its original cached task list. This is recovery of one logical request,
not authorization for a new delivery. Replaying the same signed check-in under
a different `jti` returns no newly queued tasks. Issues may re-emit its
encrypted non-task registration acknowledgement for an authenticated
registration retry, but it does not attach a new task payload.

## Result acceptance and directive safety

The implant distinguishes writing a result artifact from learning that the
controller durably accepted that exact signed result:

- HTTPS/WSS beacon endpoints, OIDC, and gRPC use their authenticated direct
  response as acceptance.
- Issues, and an Issues-backed proxy route, require an encrypted acceptance
  receipt created only after the controller accepts the result. The receipt is
  authenticated with the operator X25519 key and binds the beacon ID, task ID,
  acceptance time, and SHA-256 digest of the exact signed wire result,
  including its signature and optional-field presence. The beacon also checks
  the receipt's age and future-clock skew.
- Other asynchronous GitHub channels currently report only that an artifact
  was written. They do not claim controller acceptance.

An evaluation that uses control directives must therefore include at least one
acceptance-capable result path: HTTPS/WSS, OIDC, gRPC, Issues, or an
Issues-backed proxy route. An asynchronous-only configuration leaves the
directive pending by design.

An unacknowledged result remains in persistent beacon state and is retried as
the same cached signed result after a restart and during later loops. The task
is not executed again. While any result acceptance or accepted directive
effect remains unresolved, the beacon retries that durable lifecycle and does
not check in for or execute new tasks. Proactive credential recovery remains
available so an expired GitHub lease cannot strand that retry. A control
directive is applied only after authenticated controller acceptance has been
persisted locally:

- `kill` persists the termination marker before the process exits;
- `sleep` persists the new interval and jitter before they are used;
- `self_delete` is marked applied only after the deployed executable is
  removed or is already absent. Interpreter-launched development runs and
  deletion errors leave the directive pending.

Startup resumes any accepted directive whose local effect marker was not
durably written. This closes the crash windows between remote acceptance,
local acknowledgement, and effect application.

## Beacon state and replay memory

Beacon state version 2 is treated as security-critical input. An existing
state file with invalid JSON, an unknown version, malformed identity or ledger
fields, a mismatched beacon ID, or simultaneous primary and fallback files
stops startup. OctoC2 does not silently replace such state with a new identity
or an empty replay ledger. Recovery and scoped sidecar files may corroborate
an authoritative primary or fallback state identity, but they can never
establish an identity by themselves.
Only the complete absence of recognized state artifacts permits first-run
identity generation.

Baked and explicitly provisioned beacon IDs must use the canonical lowercase
UUID text form. `octoctl` rejects a noncanonical `--beacon-id` before it can
select or influence any state path.

The implant keeps at most 256 detailed task-ledger entries. It may evict detail
only for a completed, controller-accepted task whose directive is absent or
already applied. Started tasks, unacknowledged results, and pending directives
are never evicted to make room. If all 256 entries are non-evictable, new task
reservation stops instead of discarding safety state.

Eviction does not make a task ID executable again. A fixed-size, append-only
persisted seen-task filter retains membership after detailed history is
removed. A filter match, including a possible probabilistic false positive,
fails closed and refuses execution. Malformed filter data or a legacy state
whose prior eviction history cannot be established also fails closed. This
design bounds state size and preserves no-repeat behavior at the cost of a
small, intentional availability risk from false positives.

## HTTPS certificate lifecycle

The HTTP listener refuses to start without `OCTOC2_HTTP_SERVER_CERT` and
`OCTOC2_HTTP_SERVER_KEY`. Its certificate SAN must cover the hostname in
`OCTOC2_SERVER_URL` and every beacon recovery `serverUrl`.

- Prefer a publicly trusted certificate for remotely reachable test tunnels.
- For an internal test CA, install the CA in dashboard browsers and beacon host
  trust stores. Set `OCTOC2_HTTP_CA_CERT` for `octoctl`.
- Never set a client to skip certificate or hostname verification.
- Rotate the certificate before expiry and keep its private key outside source
  control.

## gRPC certificate lifecycle

The server requires `OCTOC2_GRPC_CA_CERT`, `OCTOC2_GRPC_SERVER_CERT`, and
`OCTOC2_GRPC_SERVER_KEY`. It also requires
`OCTOC2_GRPC_CLIENT_CERT_FINGERPRINTS`, a JSON object keyed by the same full
beacon IDs as `OCTOC2_BEACON_API_TOKENS`. A beacon requires
`SVC_GRPC_CA_CERT`, `SVC_GRPC_CLIENT_CERT`, and `SVC_GRPC_CLIENT_KEY`.

- Direct gRPC does not require a GitHub credential.
- Codespaces API/SSH mode additionally requires a protected runtime
  `SVC_CODESPACES_GITHUB_TOKEN`: a classic PAT with only the `codespace` scope.
  Fine-grained PATs can manage the Codespace lifecycle but do not yield the
  connection metadata required by GitHub CLI tunneling. App
  installation leases are repository-scoped and are rejected for this path.
- Codespaces tunneling uses the supported `gh codespace` connection service.
  Install GitHub CLI on the beacon host or set `SVC_GITHUB_CLI` to its path.
  The PAT is passed to the child process as `GH_TOKEN` and is never used as an
  SSH password. The Codespace image must start the configured mTLS gRPC service
  itself; beacons do not receive remote-shell authority to bootstrap servers.
  Initial tunnel attachment can lag the Codespace `Available` state; the
  bounded default connection window is six minutes and can be changed with
  `SVC_CODESPACE_CONNECT_MS`.
- Issue a distinct client certificate per beacon from the configured CA.
- Record each client certificate's SHA-256 fingerprint with
  `openssl x509 -in beacon-client.crt -noout -fingerprint -sha256`. The
  controller rejects missing, extra, malformed, or duplicate bindings and
  compares the live TLS peer certificate to the authenticated bearer principal
  before processing a check-in or result.
- Put the actual connection hostname or IP in the server certificate SAN.
  Direct mode validates the hostname in `SVC_GRPC_DIRECT`. SSH tunnel mode
  connects to `localhost`, so its server certificate must include `localhost`
  (and normally `127.0.0.1`) in the SAN. Do not use an insecure target-name
  override.
- Track certificate expiry outside OctoC2 and rotate before the earliest
  server or client certificate expires.
- Revoke a beacon immediately by revoking its controller credential in SQLite.
  To retire its certificate at the next restart, replace the fingerprint with
  the replacement certificate or remove that beacon from both startup maps.
  Withdrawing the client certificate or rotating the CA remains necessary when
  the CA cannot publish a usable revocation mechanism.
- Keep CA, server, and client private keys out of source control and enrollment
  artifacts.

## Server-side GitHub App and recovery keys

When proactive recovery publishing is enabled, the GitHub App private key stays
on the controller. Set `OCTOC2_RECOVERY_PUBLISH_ENABLED=true` and configure:

| Variable | Purpose |
|---|---|
| `OCTOC2_GITHUB_APP_ID` | Server-held GitHub App ID |
| `OCTOC2_GITHUB_APP_PRIVATE_KEY_FILE` | Path to the server-only App private key |
| `OCTOC2_GITHUB_APP_POLICIES` | JSON policy map keyed by full beacon ID; fixes installation, repository, and permissions |
| `OCTOC2_RECOVERY_REPO_OWNER` / `OCTOC2_RECOVERY_REPO_NAME` | Dedicated public recovery repository |
| `OCTOC2_RECOVERY_REPO_REF` | Recovery branch/ref; defaults to `main` |
| `OCTOC2_RECOVERY_WRITE_TOKEN` | Server-only credential that can update the recovery repository |
| `OCTOC2_RECOVERY_SIGNING_SECRET_FILE` | Path to the server-only Ed25519 recovery signing secret |
| `OCTOC2_RECOVERY_SIGNING_PUBLIC_KEY` | Provisioned Ed25519 public key trusted by beacons |
| `OCTOC2_RECOVERY_POLICIES` | JSON replacement-configuration policy map keyed by the same beacon IDs |
| `OCTOC2_RECOVERY_PUBLISH_INTERVAL_MS` | Optional refresh interval, constrained to 1–45 minutes |

The optional `OCTOC2_RECOVERY_NEXT_SIGNING_PUBLIC_KEY` and
`OCTOC2_RECOVERY_NEXT_SIGNING_KEY_ID` must be supplied together for planned key
rotation. Never place the App private key or recovery signing secret in a
beacon environment or build artifact.

Beacon timing configuration is also bounded at startup. `SVC_SLEEP` must be an
integer from 1 through 86400 seconds, `SVC_JITTER` must be from 0 through 1, and
`SVC_RECOVERY_POLL_INTERVAL_MS` must be an integer from 10000 through 2700000
milliseconds. Malformed values are rejected instead of becoming a tight loop
or silently delaying proactive renewal.

## Remote modules

Unsigned remote module execution is disabled. The dashboard has no module
controls, the public CLI has no module build/upload command, and
`load-module` task submission is rejected. The former loader, server-side
module store, sample module payloads, and their tests have been removed.

## Capability evidence

Use these status terms:

- **Implementation present:** source code exists.
- **Unit tested:** local automated tests exercise the component.
- **Integration tested:** multiple local components passed a recorded test.
- **Live E2E verified:** a manual approved run succeeded against external test
  infrastructure for the exact revision.

Never convert implementation counts into claims that all channels are active or
operational. Dashboard “recently observed” status only reflects reported beacon
activity.

## Manual live-E2E prerequisite gate

`scripts/test-end-to-end.ts` is a prerequisite validator, not a live runner. It
never starts the controller or beacon and never reports live E2E success. The
manual `.github/workflows/ci-e2e.yml` workflow uses it only after approval by
the protected `octoc2-live-e2e` environment.

The gate requires all of the following:

- explicit authorization and cleanup acknowledgements, with a named cleanup
  owner;
- one full UUID and its version-1 public enrollment artifact in the configured
  `OCTOC2_ENROLLMENT_DIR`, ready for server import before deployment;
- an isolated private C2 repository that serves as the proxy control
  repository for this scenario;
- a separate private proxy decoy repository and a separate public recovery
  repository;
- distinct controller GitHub, operator GitHub, operator API, per-beacon API,
  recovery-writer, and two proxy-dispatch credentials;
- one exact per-beacon API-token mapping;
- server-held GitHub App and Ed25519 recovery-signing private-key files;
- exact App and recovery policies for only the enrolled test beacon;
- a recovery priority with `proxy` before `issues`, exactly one decoy proxy
  entry, and no embedded App key, lease, or static proxy credential;
- current proxy workflows, secret names, variables, route map, and open route
  issues when GitHub checking is enabled;
- loopback HTTPS configuration with a trusted CA/server certificate pair, and
  complete gRPC server/client mTLS material whenever that transport is selected.

The protected environment supplies non-secret configuration as environment
variables:

| Category | Required protected-environment variables |
|---|---|
| Identity | `OCTOC2_E2E_BEACON_ID`, `MONITORING_PUBKEY`; the workflow sets `OCTOC2_ENROLLMENT_DIR` to its temporary artifact directory |
| C2/control | `OCTOC2_REPO_OWNER`, `OCTOC2_REPO_NAME`, `OCTOC2_PROXY_CONTROL_OWNER`, `OCTOC2_PROXY_CONTROL_REPO` |
| Proxy decoy | `OCTOC2_PROXY_DECOY_OWNER`, `OCTOC2_PROXY_DECOY_REPO` |
| Recovery | `OCTOC2_RECOVERY_REPO_OWNER`, `OCTOC2_RECOVERY_REPO_NAME`, `OCTOC2_RECOVERY_REPO_REF`, `OCTOC2_RECOVERY_SIGNING_PUBLIC_KEY`, `OCTOC2_RECOVERY_SIGNING_KEY_ID` |
| GitHub App policy | `OCTOC2_GITHUB_APP_ID`, `OCTOC2_GITHUB_APP_POLICIES` |
| Optional gRPC | `OCTOC2_E2E_GRPC_DIRECT`, `OCTOC2_E2E_GRPC_SERVER_NAME` |

It supplies secret values separately:

| Category | Required protected-environment secrets |
|---|---|
| GitHub roles | `OCTOC2_SERVER_GITHUB_TOKEN`, `OCTOC2_OPERATOR_GITHUB_TOKEN`, `OCTOC2_RECOVERY_WRITE_TOKEN` |
| Controller roles | `OCTOC2_OPERATOR_API_TOKEN`, `OCTOC2_BEACON_API_TOKEN`, `OCTOC2_OPERATOR_SECRET` |
| Recovery | `OCTOC2_GITHUB_APP_PRIVATE_KEY_PEM`, `OCTOC2_RECOVERY_SIGNING_SECRET`, `OCTOC2_RECOVERY_POLICIES` |
| Proxy | `OCTOC2_PROXY_CONTROL_DISPATCH_TOKEN`, `OCTOC2_PROXY_TARGET_DISPATCH_TOKEN`, `OCTOC2_PROXY_RELAY_SIGNING_KEY` |
| HTTPS | `OCTOC2_E2E_HTTP_CA_CERT_PEM`, `OCTOC2_E2E_HTTP_SERVER_CERT_PEM`, `OCTOC2_E2E_HTTP_SERVER_KEY_PEM` |
| Optional gRPC | `OCTOC2_E2E_GRPC_CA_CERT_PEM`, `OCTOC2_E2E_GRPC_SERVER_CERT_PEM`, `OCTOC2_E2E_GRPC_SERVER_KEY_PEM`, `OCTOC2_E2E_GRPC_CLIENT_CERT_PEM`, `OCTOC2_E2E_GRPC_CLIENT_KEY_PEM` |

The workflow first builds the beacon with only its identity and public recovery
trust. It then materializes private keys in the runner's temporary directory
with restricted permissions, derives
`OCTOC2_GRPC_CLIENT_CERT_FINGERPRINTS` from the protected gRPC client
certificate when that optional path is selected, and scans the binary for every
declared server/operator credential and private key.

Local-only validation never queries GitHub:

```bash
bun run scripts/test-end-to-end.ts --dry-run
```

The approved protected environment can add read-only external checks:

```bash
bun run scripts/test-end-to-end.ts --preflight --check-github
bun run scripts/test-end-to-end.ts --preflight --check-github --grpc
bun run scripts/test-end-to-end.ts --preflight --check-github --http
```

Passing any of these commands is prerequisite evidence only. A later live
exercise remains unverified until an authorized operator records the exact
revision, isolated infrastructure, observed check-in, task/result evidence,
transport used, cleanup of GitHub artifacts, and credential/key revocation.
The prerequisite gate does not exercise live OIDC replay recovery,
duplicate-check-in delivery suppression, Issues/proxy acceptance receipts,
restart resubmission, or directive crash recovery against GitHub.

## Required verification

```bash
bun run deps:check && bun run docs:check && bun run workflows:check
bun run toolchain:check
bun run proto:check && bun run lint && bun audit
cd shared && bun test --timeout 30000 && bun run typecheck
cd ../implant && bun test --timeout 30000 && bun run typecheck
cd ../server && bun test --timeout 30000 && bun run typecheck
cd ../dashboard && bun run test && bun run lint && bun run build
cd ../octoctl && bun test --timeout 30000 && bun run typecheck
cd ../proxy && bun run typecheck && bun run build
cd ../docs-site && bun run lint && bun run build
cd ../implant && bun run build:all
cd ../server && bun run build
cd ../octoctl && bun run build
cd ../proxy && bun run build
cd .. && bun run smoke:builds
```

The E2E prerequisite workflow is deliberately not triggered by pushes or pull
requests. Configure required reviewers on the `octoc2-live-e2e` environment
before storing any test secrets there. A green prerequisite workflow is not a
live test result.

## Stop conditions

Do not proceed with an evaluation if:

- a listener would need public exposure;
- credentials cannot be separated by role;
- TLS or per-beacon authentication is unavailable for gRPC;
- a disposable private repository cannot be used;
- cleanup ownership is unclear;
- local verification fails;
- the requested activity is not explicitly authorized.

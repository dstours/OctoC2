# Architecture

OctoC2 is a multi-transport control plane built around one signed task
protocol. The transport may change during failover, but task identity,
encryption, ownership, replay protection, and result acceptance do not.

> [!IMPORTANT]
> **Authorized use only.** Apply these components and trust boundaries only to
> systems and repositories you own or have explicit permission to test.

## Component model

```text
Dashboard / octoctl
        │ authenticated operator API or scoped GitHub API
        ▼
Controller ─────────────── durable SQLite state
        │                  identities · tasks · delivery leases
        │ signed and       results · replay records · cursors
        │ encrypted envelopes
        ▼
GitHub APIs · HTTPS/WSS · gRPC/mTLS · signed relays
        │
        ▼
Pre-enrolled beacon ────── persistent identity and task ledger
```

| Component | Responsibility |
|---|---|
| Beacon (`implant/`) | Select transports, check in, decrypt and validate tasks, execute catalogued handlers, sign results, and recover configuration |
| Controller (`server/`) | Register identities, queue tasks, grant delivery leases, poll channels, verify results, persist state, and expose operator/direct APIs |
| Dashboard (`dashboard/`) | Present beacon health, task state, results, activity, and transport views to an authenticated operator |
| CLI (`octoctl/`) | Generate keys, provision environments, enroll/build beacons, queue tasks, inspect results, manage recovery, and configure proxies |
| Shared contracts (`shared/`) | Define canonical channel/task catalogs, signed envelopes, key IDs, validation rules, and result receipts |

## Identity and cryptography

OctoC2 deliberately separates cryptographic roles:

| Identity | Algorithm | Trust boundary |
|---|---|---|
| Operator encryption | X25519 / libsodium `crypto_box` | Tasks are sealed to a beacon; results are sealed to the operator |
| Beacon signing | Ed25519 | Check-ins and results are bound to the enrolled beacon identity |
| Recovery signing | Ed25519 | Dead-drop records and key transitions are authenticated independently of GitHub |
| TLS server identity | X.509 | HTTPS/gRPC endpoint name and CA trust |
| gRPC client identity | X.509 + SHA-256 fingerprint binding | Exact certificate-to-beacon binding |
| GitHub identity | App installation token, PAT, or OIDC claims | Authorization to the selected GitHub surface |
| Direct API identity | Operator or per-beacon bearer token | Controller route authorization |

Encryption does not replace authentication. A result is accepted only after
the signed envelope, enrolled beacon key, beacon/task ownership, task state,
replay record, and result digest all agree.

## Task lifecycle

1. An authenticated operator submits a catalogued task for a known beacon.
2. The controller validates arguments, seals the task to that beacon, signs the
   envelope, and persists it as `pending`.
3. One eligible channel receives an exclusive delivery lease and publishes or
   returns the task.
4. The beacon verifies and decrypts the envelope, records the task in its
   durable ledger, and dispatches the matching handler once.
5. The beacon signs and encrypts the result, then returns it through the active
   channel.
6. The controller verifies identity and ownership, persists the result, marks
   the task complete or failed, and emits a result-acceptance receipt where the
   channel supports acknowledgements.

Delivery attempts may repeat; execution may not. The durable controller state,
exclusive leases, replay store, and beacon ledger make retries safe across
process restarts.

## Transport abstraction and failover

`ConnectionFactory` builds the configured tentacles, records health, applies
the priority list, and moves to an eligible fallback after a classified
failure. A transport is eligible only when its runtime configuration and the
canonical channel prerequisites are satisfied.

GitHub transports exchange the same encrypted payload through different
artifacts. Direct transports use HTTPS or gRPC but preserve the same envelope
and ownership checks. Proxy and relay paths add signed routing; they do not
become a new source of task authority.

See [Channels](CHANNELS.md) for prerequisites and status, and [Operations and
assurance](PRODUCTION.md) for failover, listener, and acceptance policy.

## Durable state

The controller stores beacon identities and lifecycle status, queued tasks,
delivery leases, results, processed-envelope replay records, GitHub cursors,
and channel-specific state in its configured data directory. The beacon stores
its signing identity and task ledger locally.

Back up and restore these as security state, not disposable cache. Restoring
only part of the state can invalidate identity or replay assumptions. Never
copy one beacon's identity directory to another host.

## Recovery

When ordinary channels cannot authenticate, `DeadDropResolver` searches a
dedicated public recovery repository for a deterministic record. Each record
is signed by the recovery identity, sealed to one beacon, generation-numbered,
time-bounded, and constrained by the controller's complete replacement policy.

A valid record can replace transport configuration and provide a narrowed,
short-lived GitHub App installation-token lease. It cannot grant authority
outside the server's exact per-beacon policy. See [Recovery](RECOVERY.md).

## Feature boundaries

- Thirteen channel kinds are selectable; the reserved PR+SSH catalog entry is
  intentionally unavailable.
- Six task kinds are accepted: `shell`, `exec`, `ping`, `sleep`, `kill`, and
  `evasion`. Argument schemas and risk levels are centralized in `shared/`.
- Remote module loading is rejected across public surfaces.
- HTTP and gRPC listeners are opt-in. HTTP requires TLS; gRPC requires mTLS and
  a per-beacon bearer credential.
- App private keys and recovery signing secrets are controller-only.
- Channel availability is an environment claim, not a catalog claim. Local
  tests, integration tests, and live task/result qualification are reported as
  separate evidence levels.

## Trust boundaries

| Boundary | Required control |
|---|---|
| Operator → controller | Operator-only API token, trusted TLS when non-loopback |
| Beacon → controller | Per-beacon bearer, trusted TLS, and mTLS/fingerprint binding for gRPC |
| Component → GitHub | Least-privilege role credential scoped to exact repositories |
| Controller → beacon | Signed task, X25519 sealing, enrolled recipient identity |
| Beacon → controller | Signed result, ownership check, replay rejection, acceptance digest |
| Recovery repo → beacon | Recovery signature, exact beacon recipient, generation and expiry checks |
| Proxy/relay → endpoints | Signed route/configuration and exact repository or certificate bindings |

For a deployment checklist and failure policy, continue with [Operations and
assurance](PRODUCTION.md).

# OctoC2 Documentation

OctoC2 is a GitHub-native command-and-control framework for authorized
security research, with encrypted multi-channel transport and resilient
failover. This manual covers installation through operation, recovery,
verification, and development.

> [!IMPORTANT]
> **Authorized use only.** Use OctoC2 only on systems and repositories you own
> or have explicit permission to test. Keep credentials least-privileged,
> listeners private, and live-test artifacts inventoried and cleaned.

## Start here

| If you are… | Read these in order |
|---|---|
| Evaluating locally | [Installation](INSTALLATION.md) → [GitHub setup](GITHUB_SETUP.md) → [Quickstart](QUICKSTART.md) |
| Deploying an authorized environment | [Architecture](ARCHITECTURE.md) → [Configuration](CONFIGURATION.md) → [Channels](CHANNELS.md) → [Operations](PRODUCTION.md) |
| Operating day to day | [CLI](CLI.md) → [Dashboard](../dashboard/README.md) → [Troubleshooting](TROUBLESHOOTING.md) |
| Configuring resilience | [Proxy contract](../templates/proxy/README.md) → [Recovery](RECOVERY.md) |
| Reviewing or contributing | [Development](DEVELOPMENT.md) → [Verification traceability](REMEDIATION_TRACEABILITY.md) |

The [quickstart](QUICKSTART.md) is the shortest path to a pre-enrolled beacon
and a verified `ping`. The other guides explain the decisions behind each step.

## Complete guide map

### Learn and install

| Guide | Covers |
|---|---|
| [Architecture](ARCHITECTURE.md) | Components, identities, task lifecycle, durable state, transport abstraction, recovery, and trust boundaries |
| [Installation](INSTALLATION.md) | Pinned toolchain, source install, component builds, platform beacon binaries, updates, and local verification |
| [GitHub setup](GITHUB_SETUP.md) | Control/decoy/recovery topology, GitHub App UI fields, App permissions, PAT roles, installation, and rotation |
| [Quickstart](QUICKSTART.md) | Guided and manual first run, enrollment import, controller/dashboard/beacon launch, first task, and cleanup |

### Configure and operate

| Guide | Covers |
|---|---|
| [Configuration](CONFIGURATION.md) | Controller, listener, lifecycle, OIDC, recovery, beacon, dashboard, and CLI variables |
| [Channel guide](CHANNELS.md) | Full channel catalog, permission/prerequisite matrix, per-channel setup, priority, failover, and qualification |
| [CLI reference](CLI.md) | Setup, key generation, inventory, tasks, results, builds, recovery, proxy, services, and JSON output |
| [Dashboard guide](../dashboard/README.md) | Local UI, TLS trust, login roles, live/direct modes, and activity semantics |
| [Operations and assurance](PRODUCTION.md) | Listener exposure, credentials, identity, replay, result acceptance, state, certificates, evidence, and stop conditions |
| [Troubleshooting](TROUBLESHOOTING.md) | Startup, GitHub errors, decryption, acknowledgements, proxy, TLS, gRPC, Codespaces, OIDC, state, and CI |

### Resilience and verification

| Guide | Covers |
|---|---|
| [Recovery](RECOVERY.md) | Deterministic dead-drops, exact App policies, short-lived leases, publication, renewal, and key rotation |
| [Proxy workflow contract](../templates/proxy/README.md) | Control/decoy workflows, variables, secrets, signed routes, deduplication, and artifact cleanup |
| [Remediation traceability](REMEDIATION_TRACEABILITY.md) | Finding-to-code mapping, automated evidence, live qualifications, and cleanup records |
| [Development](DEVELOPMENT.md) | Workspace conventions, contract changes, tests, builds, documentation standards, and change checklist |

## Feature overview

- One signed and encrypted task protocol across GitHub artifacts, HTTPS/WSS,
  gRPC/mTLS, OIDC, Codespaces, proxy, and relay paths.
- Thirteen selectable channel kinds, with prerequisites and evidence status
  reported separately; one reserved catalog entry remains unavailable.
- Pre-enrolled X25519 encryption and Ed25519 signing identities.
- Durable SQLite controller state, delivery leases, replay records, cursors,
  results, and lifecycle state.
- Persistent beacon task ledger for at-most-once execution across restarts.
- Authenticated operator CLI and local dashboard with separated credential roles.
- Signed, generation-numbered recovery records carrying narrowed GitHub App
  installation-token leases.
- Strict task catalog with routine, elevated, and destructive risk classes.
- Five platform beacon build targets: Linux x64/arm64, Windows x64, and macOS
  Apple silicon/Intel.

## System map

```text
dashboard / octoctl
        │ operator API token
        ▼
controller ───────────────── durable SQLite state
        │                    identities · tasks · delivery leases
        │ signed + sealed     results · replay records · cursors
        ▼
GitHub APIs · HTTPS · gRPC · signed relays
        │
        ▼
pre-enrolled beacon ──────── persistent identity + task ledger
```

The `shared/` workspace is authoritative for channel IDs, task kinds, envelope
shapes, signatures, and validation rules.

## Configuration families

| Prefix | Component | Purpose |
|---|---|---|
| `OCTOC2_HTTP_*` | Controller/operator | HTTPS/WSS listener and CA trust |
| `OCTOC2_GRPC_*` | Controller | gRPC listener, mTLS, and exact certificate fingerprints |
| `OCTOC2_BEACON_*` | Controller/build | Beacon credentials, lifecycle, and pre-enrollment identity |
| `OCTOC2_GITHUB_APP_*` | Controller | App identity, private-key file, and exact token policies |
| `OCTOC2_RECOVERY_*` | Controller/build/beacon | Recovery repository, signing trust, publication, and policy |
| `SVC_*` | Beacon | Runtime transport credentials, endpoints, timing, and cleanup |
| `VITE_*` | Dashboard/docs site | Build-time controller/repository coordinates |

Configuration is fail-closed at security boundaries: incomplete TLS material,
ambiguous credential roles, mismatched identities, malformed policy, and
unsafe timing stop startup or make the affected transport ineligible.

## Evidence vocabulary

| Term | Meaning |
|---|---|
| Unit tested | A deterministic local test covers one component or contract |
| Integration tested | Multiple local components complete a recorded interaction |
| Live qualified | An authorized external run observes the stated transport boundary and records cleanup |
| Live task/result | Registration, encrypted task delivery, beacon receipt, signed result publication, and controller acceptance complete through the named channel |

Use the most specific label supported by evidence for the exact revision.
Catalog presence, successful registration, and artifact publication alone do
not establish live task/result qualification.

## Getting help

Check [Troubleshooting](TROUBLESHOOTING.md), then capture the exact revision,
component versions, redacted logs, channel, and failing command. Never attach
dotenv files, PATs, private keys, bearer values, private-repository content,
hostnames, or usernames to a public report.

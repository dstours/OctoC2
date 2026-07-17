# OctoC2 Documentation

> [!IMPORTANT]
> **Authorized use only.** Use OctoC2 only on systems and repositories you own
> or have explicit permission to test. Keep credentials scoped and controller
> surfaces private.

This directory contains the operator and engineering guides for OctoC2. Start
with the guide that matches the job in front of you.

## Choose a guide

| Goal | Guide | What it covers |
|---|---|---|
| Launch the local stack | [Quickstart](QUICKSTART.md) | Toolchain, credentials, TLS, controller, dashboard, CLI, and verification |
| Configure an environment | [Operations and assurance](PRODUCTION.md) | Listener policy, replay safety, state lifecycle, certificates, and operational checks |
| Provision credential recovery | [Recovery](RECOVERY.md) | GitHub App policies, signed recovery records, token leases, renewal, and key rotation |
| Review implementation evidence | [Remediation traceability](REMEDIATION_TRACEABILITY.md) | Finding-to-code mapping, automated coverage, live qualifications, and cleanup evidence |
| Operate the web interface | [Dashboard guide](../dashboard/README.md) | Local development, TLS trust, login roles, and activity semantics |
| Configure a proxy route | [Proxy workflow contract](../templates/proxy/README.md) | Control/decoy topology, workflows, variables, secrets, signatures, and deduplication |

## System map

```text
dashboard / octoctl
        │ operator API token
        ▼
     server ─────────────── SQLite state
        │                         │
        │ signed task envelopes   │ identities, leases,
        │                         │ results, replay state
        ▼                         │
GitHub APIs / HTTPS / gRPC ◄──────┘
        │
        ▼
     implant
```

The `shared/` workspace defines the canonical task catalog, channel catalog,
signed envelopes, key identifiers, and result-signature payloads used by every
component.

## Common workflows

### First local run

1. Install the pinned Bun dependency graph.
2. Generate and verify protocol bindings.
3. Create an operator X25519 keypair.
4. Prepare a private control repository and role-separated credentials.
5. Configure trusted TLS before enabling HTTP or gRPC.
6. Start the controller, dashboard, and CLI.
7. Verify one harmless ping task and its accepted signed result.

Follow the [quickstart](QUICKSTART.md) for commands and configuration.

### Add a transport

1. Check the channel catalog prerequisites in `shared/src/channels.ts`.
2. Grant only the declared repository permissions.
3. Keep App private keys on the controller; issue a narrowed installation-token
   lease when the channel supports it.
4. Add the channel to the beacon priority list.
5. Run its implant and controller test suites.
6. Record live task/result evidence and artifact cleanup for external tests.

### Prepare deterministic recovery

1. Create a dedicated public recovery repository.
2. Provision the recovery Ed25519 signing identity.
3. Configure exact per-beacon GitHub App policies.
4. Configure the complete replacement policy for each beacon.
5. Publish signed, sealed records and verify proactive renewal before lease
   expiry.

The [recovery guide](RECOVERY.md) defines the exact record and policy format.

## Configuration families

| Prefix | Component | Purpose |
|---|---|---|
| `OCTOC2_HTTP_*` | Controller and operator clients | HTTPS/WSS listener, certificates, URL, and CA trust |
| `OCTOC2_GRPC_*` | Controller | gRPC listener, mTLS material, and certificate fingerprints |
| `OCTOC2_BEACON_*` | Controller | Per-beacon API credentials and lifecycle thresholds |
| `OCTOC2_GITHUB_APP_*` | Controller | App identity, private key, and narrowed token policies |
| `OCTOC2_RECOVERY_*` | Controller and build tooling | Recovery repository, signing identity, publication, and policies |
| `SVC_*` | Beacon runtime | Enrolled identity, transport credentials, certificates, timing, and recovery trust |

Configuration is fail-closed: malformed security state, missing required TLS
material, ambiguous identities, unsafe timing, and inconsistent credential
maps stop startup instead of selecting a weaker fallback.

## Verification vocabulary

| Term | Meaning |
|---|---|
| Unit tested | A local automated test exercises one component or contract |
| Integration tested | Multiple local components complete a recorded interaction |
| Live qualified | An authorized external run observes the stated transport boundary and records cleanup |
| Live task/result | Registration, encrypted task delivery, implant receipt, signed result publication, and controller acceptance complete through the channel |

Use the most specific term supported by the evidence for the exact revision.

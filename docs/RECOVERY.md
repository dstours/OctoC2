# Deterministic Recovery and GitHub App Authentication

> [!IMPORTANT]
> **Authorized use only.** Keep recovery signing material and GitHub App
> private keys on the controller, use scoped repositories, and configure this
> workflow only for systems you have explicit permission to test.

OctoC2 keeps every GitHub App private key on the server. A beacon receives
only short-lived, repository- and permission-bound installation-token leases
inside a signed and sealed recovery record. There is no beacon-side App-key
mode and no fallback from an expired or rejected lease to a shared PAT.

## Recovery endpoint

Use a dedicated public repository whose contents are otherwise inert. The
server writes exactly one object per enrolled beacon:

```text
GET /repos/{owner}/{repo}/contents/drops/{sha256(beaconId)}.bin?ref={ref}
```

Beacon reads are anonymous. Server or operator writes use a dedicated
repository-scoped credential. OctoC2 does not use code search, Gists, or
guessable beacon identifiers to discover recovery data.

The file contains a base64url X25519 sealed box for the enrolled beacon. Its
plaintext is a canonical version-2 recovery record signed by the configured
recovery Ed25519 key. Verification binds:

- Beacon ID and recovery signer identity
- Signing-key ID
- Monotonic generation
- Issued-at and expiry timestamps
- Hash of the complete replacement configuration
- Main and proxy token leases to the same beacon and their exact repositories

The record expiry cannot exceed any included token lease. Stale, expired,
tampered, wrongly sealed, or wrongly signed records are rejected without
changing live configuration.

## Persisted expiry and trust ratchet

After accepting a record, the beacon persists a version-2 recovery snapshot
that includes the signed outer `expiresAt` value. On restart, the replacement
configuration is reusable only while the outer record and every contained
primary or proxy token lease remain unexpired.

Expiry disables credentials, but it does not roll back already accepted trust.
The beacon still restores the highest accepted generation and the signing
public key/key ID selected by that generation. A later recovery record must
advance from that trust floor, so expiration cannot re-enable an older signer
or generation.

Legacy version-1 snapshots did not preserve the signed outer expiry. Their
configuration and token leases are therefore never reused after restart. They
are loaded only as trust-ratchet metadata: the accepted generation and rotated
signing key remain authoritative.

Recovery state is security-critical input. Invalid JSON, unexpected fields,
an unknown version, a beacon mismatch, malformed timestamps or keys, an outer
expiry beyond a contained lease, or conflicting trust at the same generation
stops startup. The beacon does not discard a malformed snapshot and continue
with weaker recovery trust.

## Server configuration

Recovery publication is opt-in:

```text
OCTOC2_RECOVERY_PUBLISH_ENABLED=true
OCTOC2_GITHUB_APP_ID=12345
OCTOC2_GITHUB_APP_PRIVATE_KEY_FILE=/run/secrets/octoc2-app.pem
OCTOC2_RECOVERY_SIGNING_SECRET_FILE=/run/secrets/recovery-ed25519.key
OCTOC2_RECOVERY_SIGNING_PUBLIC_KEY=<base64url-32-byte-public-key>
OCTOC2_RECOVERY_SIGNING_KEY_ID=ed25519:<sha256>
OCTOC2_RECOVERY_WRITE_TOKEN=<dedicated-recovery-repo-writer>
OCTOC2_RECOVERY_REPO_OWNER=example
OCTOC2_RECOVERY_REPO_NAME=octoc2-recovery
OCTOC2_RECOVERY_REPO_REF=main
```

The App and recovery signing secret files must exist only on the server. The
recovery repository must be public; startup publication fails closed if GitHub
reports it as private. The default refresh interval is 30 minutes and can be
set with `OCTOC2_RECOVERY_PUBLISH_INTERVAL_MS` from 60,000 through 2,700,000
milliseconds.

`OCTOC2_GITHUB_APP_POLICIES` limits what the server may mint. The primary
repository is required. Each proxy repository has a separate exact policy and
may use a different App installation:

```json
{
  "beacon-id": {
    "installationId": 1001,
    "repository": { "owner": "example", "repo": "control" },
    "permissions": {
      "metadata": "read",
      "issues": "write",
      "contents": "write",
      "variables": "write"
    },
    "proxyRepositories": [
      {
        "installationId": 2002,
        "repository": { "owner": "example-decoy", "repo": "infra-utils" },
        "permissions": {
          "metadata": "read",
          "issues": "write",
          "variables": "read"
        }
      }
    ]
  }
}
```

`OCTOC2_RECOVERY_POLICIES` supplies the non-secret complete configuration.
Proxy entries deliberately contain no credential; the publisher mints and
inserts the matching short-lived lease:

```json
{
  "beacon-id": {
    "serverUrl": "https://controller.example.test",
    "controllerToken": "unique-beacon-controller-token",
    "monitoringPublicKey": "<base64url-x25519-public-key>",
    "tentaclePriority": ["proxy", "issues"],
    "relayConsortium": [],
    "proxyRepos": [
      {
        "owner": "example-decoy",
        "repo": "infra-utils",
        "innerKind": "issues",
        "decoyIssue": 1
      }
    ],
    "sleepSeconds": 60,
    "jitter": 0.2
  }
}
```

The App-policy and recovery-policy objects must name the same beacon IDs.
Each beacon may define at most one proxy route. Proxy routes are Issues-only
and require `metadata:read`, `issues:write`, and `variables:read` so the beacon
can validate the decoy repository's `MONITORING_PUBKEY`. The main lease must
likewise satisfy every selected GitHub channel plus `metadata:read` and at
least `variables:read` for the operator key.

## Beacon provisioning and renewal

Set the public recovery repository and recovery signing trust variables in the
environment that runs `octoctl build-beacon`. The build embeds only these
public values:

```text
OCTOC2_RECOVERY_REPO_OWNER
OCTOC2_RECOVERY_REPO_NAME
OCTOC2_RECOVERY_REPO_REF
OCTOC2_RECOVERY_SIGNING_PUBLIC_KEY
OCTOC2_RECOVERY_SIGNING_KEY_ID
```

No App private key, recovery signing secret, repository write token, or
installation token is embedded. A credentialless beacon may read and verify
its public recovery path before registering tentacles.

The beacon polls proactively when its primary or proxy lease reaches
`renewAfter`, after an authentication rejection, and when all configured
channels are exhausted. An accepted configuration is persisted with mode
`0600`, then applied as a complete replacement and all tentacles are rebuilt.
This includes controller URL/token, monitoring and next recovery keys, main
repository/lease, proxy repository leases, priority, relays, sleep, and jitter.

If the process restarts after the accepted snapshot expires, none of those
credentials or transport settings are activated from disk. The retained
generation and signing-key ratchet are applied first, and the beacon must
obtain a newer valid deterministic recovery record before rebuilding
credentialed channels.

## Manual publication

`octoctl drop create` is an offline/manual publisher for a complete
`RecoveryConfigurationV2` JSON document. It requires a positive generation,
the recovery signing secret-key file, the public signing key/key ID, and the
dedicated recovery writer token. It verifies the signature locally, checks
that the recovery repository is public, and creates or updates only the
deterministic path.

Partial updates and App-key inputs are not accepted.

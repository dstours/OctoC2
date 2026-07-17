# Configuration Reference

OctoC2 reads configuration from environment variables, protected files, and
pre-enrollment defines created by `octoctl build-beacon`. This page covers the
operator-facing variables; [Operations and assurance](PRODUCTION.md) and
[Recovery](RECOVERY.md) define their security invariants in depth.

> [!IMPORTANT]
> **Authorized use only.** Keep every configured repository, identity, and
> listener within the approved environment and keep secrets out of source.

## Loading and precedence

- `octoctl start --env <path>` loads the selected dotenv file for locally
  managed components.
- Directly started Bun processes inherit the shell environment.
- Explicit CLI options override their documented environment fallback.
- Full beacon builds bake identity and selected non-secret routing fields.
- Signed recovery configuration can replace the recovery-controlled runtime
  fields only when its complete policy, signature, recipient, generation, and
  expiry validate.

Never commit `.env`, PEM files, bearer-token maps, PATs, enrollment artifacts,
or controller state.

## Minimal controller

| Variable | Required | Default | Purpose |
|---|---:|---|---|
| `OCTOC2_SERVER_GITHUB_TOKEN` | Yes | — | Server GitHub API credential |
| `OCTOC2_REPO_OWNER` | Yes | — | Control repository owner |
| `OCTOC2_REPO_NAME` | Yes | — | Control repository name |
| `OCTOC2_OPERATOR_SECRET` | Yes | — | Base64url 32-byte X25519 secret |
| `OCTOC2_POLL_INTERVAL_MS` | No | `30000` | GitHub channel polling interval |
| `OCTOC2_DATA_DIR` | No | `./data` | SQLite and controller state directory |
| `OCTOC2_SERVER_GIST_TOKEN` | For Gist | — | Dedicated controller Gist PAT |
| `OCTOC2_ENROLLMENT_DIR` | Recommended | — | Directory of pre-enrollment artifacts imported at startup |

The controller resolves the operator public key from the
`MONITORING_PUBKEY` repository variable and checks it against the configured
operator secret.

## HTTPS and operator API

| Variable | Required when enabled | Default | Purpose |
|---|---:|---|---|
| `OCTOC2_HTTP_ENABLED` | — | `false` | Enable HTTPS/WSS operator and beacon API |
| `OCTOC2_HTTP_HOST` | No | `127.0.0.1` | Bind host |
| `OCTOC2_HTTP_PORT` | No | `8080` | Bind port |
| `OCTOC2_HTTP_SERVER_CERT` | Yes | — | Server certificate chain file |
| `OCTOC2_HTTP_SERVER_KEY` | Yes | — | Server private-key file |
| `OCTOC2_HTTP_CA_CERT` | Client-side | — | CA trust file used by CLI/development tooling |
| `OCTOC2_OPERATOR_API_TOKEN` | Yes | — | Operator-only bearer credential |
| `OCTOC2_BEACON_API_TOKENS` | Yes | — | JSON map of exact beacon ID to unique bearer token |
| `OCTOC2_DASHBOARD_ORIGIN` | No | local policy | Allowed dashboard origin |

Ports must be integers from 1 through 65535. Non-loopback binds produce an
exposure warning and require an explicitly reviewed network boundary.

Example credential map:

```json
{"2f10b98a-0000-4000-8000-000000000001":"replace-with-a-unique-random-token"}
```

The GitHub token, operator API token, and every beacon token must be distinct.

## gRPC

| Variable | Required when enabled | Default | Purpose |
|---|---:|---|---|
| `OCTOC2_GRPC_ENABLED` | — | `false` | Enable direct/Codespaces/relay gRPC |
| `OCTOC2_GRPC_HOST` | No | `127.0.0.1` | Bind host |
| `OCTOC2_GRPC_PORT` | No | `50051` | Bind port |
| `OCTOC2_GRPC_CA_CERT` | Yes | — | CA used to verify client certificates |
| `OCTOC2_GRPC_SERVER_CERT` | Yes | — | Server certificate chain |
| `OCTOC2_GRPC_SERVER_KEY` | Yes | — | Server private key |
| `OCTOC2_GRPC_CLIENT_CERT_FINGERPRINTS` | Yes | — | JSON map of beacon ID to exact SHA-256 client-cert fingerprint |
| `OCTOC2_BEACON_API_TOKENS` | Yes | — | Per-beacon bearer map, also required for gRPC |

Each beacon needs a distinct client certificate. A shared certificate or
wildcard fingerprint map is rejected by policy.

## Lifecycle and replay windows

| Variable | Default | Constraint or meaning |
|---|---:|---|
| `OCTOC2_LIFECYCLE_INTERVAL_MS` | `60000` | Sweep interval |
| `OCTOC2_BEACON_DORMANT_AFTER_MS` | `600000` | Mark a silent beacon dormant after 10 minutes |
| `OCTOC2_BEACON_LOST_AFTER_MS` | `86400000` | Mark it lost after 24 hours; must exceed dormant threshold |
| `OCTOC2_PROCESSED_MESSAGE_RETENTION_MS` | `2592000000` | Retain replay records for 30 days |
| `OCTOC2_CHECKIN_MAX_AGE_MS` | `1800000` | Reject check-ins older than 30 minutes |
| `OCTOC2_CHECKIN_MAX_FUTURE_SKEW_MS` | `300000` | Allow at most five minutes future clock skew |

## OIDC

Set `OCTOC2_OIDC_BINDINGS` to an array of exact bindings:

```json
[
  {
    "repository": "Owner/Repo",
    "beaconId": "2f10b98a-0000-4000-8000-000000000001",
    "subjects": ["repo:Owner/Repo:environment:prod"],
    "workflowRefs": ["Owner/Repo/.github/workflows/transport.yml@refs/heads/main"]
  }
]
```

`OCTOC2_OIDC_AUDIENCE` optionally replaces the default audience. Repository,
beacon ID, subject, and workflow ref are exact; wildcards and empty arrays are
not accepted.

## Recovery publisher

Set `OCTOC2_RECOVERY_PUBLISH_ENABLED=true`, then configure:

- `OCTOC2_GITHUB_APP_ID`
- `OCTOC2_GITHUB_APP_PRIVATE_KEY_FILE`
- `OCTOC2_GITHUB_APP_POLICIES`
- `OCTOC2_RECOVERY_REPO_OWNER`, `OCTOC2_RECOVERY_REPO_NAME`, and optional
  `OCTOC2_RECOVERY_REPO_REF` (default `main`)
- `OCTOC2_RECOVERY_WRITE_TOKEN`
- `OCTOC2_RECOVERY_SIGNING_SECRET_FILE`
- `OCTOC2_RECOVERY_SIGNING_PUBLIC_KEY` and optional derived
  `OCTOC2_RECOVERY_SIGNING_KEY_ID`
- `OCTOC2_RECOVERY_POLICIES`
- optional `OCTOC2_RECOVERY_PUBLISH_INTERVAL_MS`
- optional paired `OCTOC2_RECOVERY_NEXT_SIGNING_PUBLIC_KEY` and
  `OCTOC2_RECOVERY_NEXT_SIGNING_KEY_ID` during key rotation

App and recovery policies must name the same exact beacon IDs. Policy formats
are documented in [Recovery](RECOVERY.md).

## Beacon runtime

### Identity and repository

| Variable | Required | Purpose |
|---|---:|---|
| `OCTOC2_REPO_OWNER`, `OCTOC2_REPO_NAME` | Yes | Current control repository |
| `SVC_GITHUB_TOKEN` | One bootstrap path | Explicit scoped repository credential |
| `SVC_GITHUB_TOKEN_LEASE` | One bootstrap path | Server-issued, repository- and beacon-bound lease JSON |
| `SVC_BEACON_API_TOKEN` | Direct transports | Beacon's unique controller bearer credential |
| `SVC_GIST_TOKEN` | Gist | Dedicated beacon Gist PAT |
| `OCTOC2_OPERATOR_PUBKEY` | Without GitHub key lookup | Provisioned 32-byte X25519 public key |

Configure either `SVC_GITHUB_TOKEN` or `SVC_GITHUB_TOKEN_LEASE`, never both.
App private-key variables are rejected on a beacon. Full builds provision the
beacon ID, X25519 pair, and Ed25519 signing identity; hand-setting those defines
is discouraged.

### Selection and timing

| Variable | Default | Constraint or purpose |
|---|---:|---|
| `SVC_TENTACLE_PRIORITY` | Auto-detect direct gRPC, HTTP, then Issues | Comma-separated selectable channel kinds |
| `SVC_SLEEP` | `60` | Integer seconds, 1 through 86400 |
| `SVC_JITTER` | `0.3` | Number from 0 through 1 |
| `SVC_CLEANUP_DAYS` | disabled | Result-comment retention; `0` means immediate cleanup |
| `SVC_RECOVERY_POLL_INTERVAL_MS` | `60000` | 10000 through 2700000 |
| `OCTOC2_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, or `error` |
| `OCTOC2_STATE_DIR` | platform state path | Override persistent beacon state directory |

Invalid entries in an explicit priority list are logged and ignored; if no
valid entry remains, Issues is selected. Review the startup log instead of
assuming a misspelled channel was selected.

### HTTP, gRPC, and Codespaces

| Variable | Purpose |
|---|---|
| `SVC_HTTP_URL` | Trusted HTTPS controller origin |
| `SVC_GRPC_DIRECT` | Direct TLS gRPC `host:port` |
| `SVC_GRPC_CA_CERT` | Trusted server CA file |
| `SVC_GRPC_CLIENT_CERT`, `SVC_GRPC_CLIENT_KEY` | Beacon-specific mTLS identity |
| `SVC_GRPC_CODESPACE_NAME` | Existing approved Codespace name |
| `SVC_GITHUB_USER` | GitHub username for Codespace SSH |
| `SVC_CODESPACES_GITHUB_TOKEN` | Dedicated user-scoped Codespaces PAT |
| `SVC_AUTO_PROVISION_CODESPACE` | Explicit `true`/`1` opt-in to create/start a Codespace |
| `SVC_GRPC_PORT` | Remote gRPC port, default `50051` |
| `SVC_GRPC_LOCAL_PORT` | Local SSH-forward port, default `50051` |

Do not point `SVC_GRPC_DIRECT` at a GitHub Dev Tunnels HTTPS URL; use the SSH
tunnel path for gRPC or `SVC_HTTP_URL` for HTTPS.

### Issues acknowledgement tuning

| Variable | Default |
|---|---:|
| `SVC_POLL_TIMEOUT_MS` | `30000` |
| `SVC_POLL_RETRY_MS` | `10000` |
| `SVC_RESULT_ACK_TIMEOUT_MS` | `120000` |
| `SVC_RESULT_ACK_RETRY_MS` | `5000` |
| `SVC_ISSUE_TITLE` | Generated/default title policy |

Increase acknowledgement windows only to accommodate measured GitHub or proxy
latency. A longer timeout does not fix missing permissions or a mismatched key.

### Recovery bootstrap

The beacon requires these source fields together:

- `OCTOC2_RECOVERY_REPO_OWNER`
- `OCTOC2_RECOVERY_REPO_NAME`
- `OCTOC2_RECOVERY_REPO_REF`

It also requires these trust fields together:

- `OCTOC2_RECOVERY_SIGNING_PUBLIC_KEY`
- `OCTOC2_RECOVERY_SIGNING_KEY_ID`

Source and trust groups must both be present. `SVC_PROXY_REPOS` is retired;
proxy routes and their short-lived credentials must arrive through signed
recovery configuration.

## Dashboard

| Variable | Purpose |
|---|---|
| `VITE_C2_SERVER_URL` | Bare HTTPS controller origin; no path, query, fragment, or userinfo |
| `VITE_GITHUB_OWNER`, `VITE_GITHUB_REPO` | Direct GitHub fallback repository |

Dashboard credentials are entered at login and held in React memory only. The
development proxy verifies controller TLS.

## Placeholder-only dotenv example

```dotenv
OCTOC2_SERVER_GITHUB_TOKEN=<controller-repo-token>
OCTOC2_REPO_OWNER=<owner>
OCTOC2_REPO_NAME=<private-control-repo>
OCTOC2_OPERATOR_SECRET=<base64url-x25519-secret>
OCTOC2_DATA_DIR=<absolute-private-data-directory>

OCTOC2_HTTP_ENABLED=true
OCTOC2_HTTP_HOST=127.0.0.1
OCTOC2_HTTP_PORT=8080
OCTOC2_HTTP_SERVER_CERT=<absolute-server-cert-path>
OCTOC2_HTTP_SERVER_KEY=<absolute-server-key-path>
OCTOC2_HTTP_CA_CERT=<absolute-ca-cert-path>
OCTOC2_OPERATOR_API_TOKEN=<unique-operator-bearer>
OCTOC2_BEACON_API_TOKENS={"<exact-beacon-id>":"<unique-beacon-bearer>"}
```

Keep beacon runtime configuration in the target's protected environment, not
the controller dotenv when the target is a different machine.

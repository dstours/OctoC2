<p align="center">
  <img src="docs-site/public/logo.png" alt="OctoC2" width="150" />
</p>

<h1 align="center">OctoC2</h1>

<p align="center">
  A GitHub-native, encrypted control plane for authorized systems research.
</p>

> [!IMPORTANT]
> **Authorized use only.** Run OctoC2 only on systems and repositories you own
> or have explicit permission to test. Use private test infrastructure,
> least-privilege credentials, trusted TLS, and private listener bindings.

OctoC2 combines a TypeScript beacon, durable controller, local operator
dashboard, and CLI. GitHub-backed and direct transports share one signed task
protocol, one identity model, and the same result-ownership rules.

## Start here

| I want to… | Read or run |
|---|---|
| Browse all documentation | [Documentation index](docs/README.md) |
| Understand the system | [Architecture](#architecture) |
| Set up a local environment | [Local evaluation quickstart](docs/QUICKSTART.md) |
| Configure listeners and certificates | [Operations and assurance](docs/PRODUCTION.md) |
| Configure GitHub App recovery | [Recovery guide](docs/RECOVERY.md) |
| Review implementation and live evidence | [Verification traceability](docs/REMEDIATION_TRACEABILITY.md) |
| Use the dashboard | [Dashboard guide](dashboard/README.md) |

## Architecture

```text
 Operator CLI / Dashboard
            │
            │ authenticated operator API
            ▼
 ┌──────────────────────────┐
 │        Controller        │
 │ identity · tasks · state │
 └────────────┬─────────────┘
              │ signed + encrypted envelopes
       ┌──────┴─────────┐
       ▼                ▼
 GitHub transports   HTTPS / gRPC
       │                │
       └──────┬─────────┘
              ▼
      Pre-enrolled beacon
```

Every transport uses the canonical contracts in `shared/`. The controller
persists identities, credentials, tasks, results, delivery leases, replay
records, and channel cursors in SQLite. The beacon persists its Ed25519
identity and task ledger so a delivered task cannot be executed twice after a
restart.

## Workspaces

| Workspace | Responsibility |
|---|---|
| `implant/` | Beacon runtime, task lifecycle, recovery, and transport clients |
| `server/` | Controller services, durable state, channel polling, HTTP, and gRPC |
| `dashboard/` | Local operator interface for beacon and task activity |
| `octoctl/` | Keys, enrollment, builds, task submission, and proxy provisioning |
| `shared/` | Task catalog, channel catalog, envelopes, identities, and signatures |
| `proxy/` | Relay workflow build and validation |
| `docs-site/` | Public documentation site |

## Transport paths

OctoC2 can exchange the same task protocol through several environment-specific
paths:

- **GitHub artifacts:** Issues, branches, Actions variables, deployments,
  Gists, repository variables, steganographic PNGs, and Git Notes.
- **Direct controller paths:** HTTPS/WebSocket, gRPC with mTLS, and GitHub
  Actions OIDC.
- **Relayed paths:** a signed two-repository proxy, relay consortium, and
  Codespaces SSH tunnel.

Transport availability depends on its declared GitHub permissions, identity
material, and network prerequisites. See the [quickstart](docs/QUICKSTART.md)
for exact credential roles and [traceability record](docs/REMEDIATION_TRACEABILITY.md)
for test evidence.

## Quick setup

### Requirements

- Bun `1.3.14`
- Node.js `22.14.0` only for tooling that explicitly requires Node
- GitHub CLI when using Codespaces tunneling

Install the pinned dependency graph and generate the protocol bindings:

```bash
bun install --frozen-lockfile
bun run proto:gen
bun run deps:check
bun run docs:check
```

Generate the operator encryption keypair:

```bash
cd octoctl
bun run src/index.ts keygen
```

Keep the secret key and all repository credentials outside source control.

### Optional local HTTPS listener

Controller listeners remain disabled until explicitly enabled. A minimal
loopback HTTPS/WSS configuration is:

```text
OCTOC2_HTTP_ENABLED=true
OCTOC2_HTTP_HOST=127.0.0.1
OCTOC2_HTTP_PORT=8080
OCTOC2_HTTP_SERVER_CERT=/absolute/path/server.crt
OCTOC2_HTTP_SERVER_KEY=/absolute/path/server.key
OCTOC2_HTTP_CA_CERT=/absolute/path/ca.crt
OCTOC2_OPERATOR_API_TOKEN=<unique-operator-token>
OCTOC2_BEACON_API_TOKENS={"<beacon-id>":"<unique-beacon-token>"}
```

The certificate SAN must cover the hostname clients use. Install an internal
CA in each client trust store; there is no certificate-verification bypass.

Start the controller and dashboard in separate terminals:

```bash
cd server
bun run src/index.ts
```

```bash
cd dashboard
bun run dev
```

The dashboard binds to `http://127.0.0.1:5173`.

## Identity and credential boundaries

Do not reuse values across these roles:

| Role | Configuration | Used by |
|---|---|---|
| Controller GitHub API | `OCTOC2_SERVER_GITHUB_TOKEN` | Server-side GitHub channels |
| Operator controller API | `OCTOC2_OPERATOR_API_TOKEN` | Dashboard and CLI REST/SSE calls |
| Beacon controller API | `OCTOC2_BEACON_API_TOKENS` / `SVC_BEACON_API_TOKEN` | HTTPS and gRPC beacon routes |
| Operator encryption | `OCTOC2_OPERATOR_SECRET` | Task sealing and result decryption |
| GitHub App private key | `OCTOC2_GITHUB_APP_PRIVATE_KEY_FILE` | Server-only token minting |
| Codespaces user access | `SVC_CODESPACES_GITHUB_TOKEN` | Runtime Codespaces API/SSH discovery |

Direct gRPC additionally requires a trusted CA, a distinct client certificate
per beacon, and an exact SHA-256 certificate fingerprint binding. Gist uses
separate controller and beacon credentials for the same dedicated account.

## Security model

- Network listeners are opt-in and loopback-first.
- HTTP is TLS-only; gRPC requires mTLS and a per-beacon bearer credential.
- Beacon identities use provisioned Ed25519 signing keys distinct from X25519
  encryption keys.
- Tasks and results are signed, identity-bound, and ownership-checked.
- Exclusive delivery leases prevent competing transports from claiming one
  task simultaneously.
- Durable replay state and the beacon task ledger survive restarts.
- GitHub App private keys and recovery signing secrets remain server-side.
- Unsigned remote module execution is rejected across the public surfaces.

Repository permissions are still an operational boundary: a broad repository
writer may delete, delay, or reorder artifacts even when it cannot forge their
authenticated contents. Separate repositories and narrowly scoped credentials
provide stronger isolation.

## Verify a change

Run repository policy checks first:

```bash
bun run deps:check
bun run docs:check
bun run workflows:check
bun run toolchain:check
bun run proto:check
bun run lint
bun audit
```

Then run tests and strict type checks in every affected workspace:

```bash
cd shared && bun test --timeout 30000 && bun run typecheck
cd ../implant && bun test --timeout 30000 && bun run typecheck
cd ../server && bun test --timeout 30000 && bun run typecheck
cd ../dashboard && bun run test && bun run lint && bun run build
cd ../octoctl && bun test --timeout 30000 && bun run typecheck
cd ../proxy && bun run typecheck && bun run build
cd ../docs-site && bun run lint && bun run build
```

Build beacon targets and smoke-test distributable artifacts:

```bash
cd implant && bun run build:all
cd ../server && bun run build
cd ../octoctl && bun run build
cd ../proxy && bun run build
cd .. && bun run smoke:builds
```

Live qualification is a separate, explicitly authorized exercise. Record the
revision, environment, credential roles, observed task/result path, and cleanup
result alongside the test evidence.

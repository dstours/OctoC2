# Local Evaluation Quickstart

> [!IMPORTANT]
> **Authorized use only.** Use a private repository and scoped credentials,
> keep listeners on loopback or a reviewed private network, and test only
> systems and repositories you have explicit permission to access.

## 1. Install and verify the toolchain

Use Bun `1.3.14`. The repository pins Node.js `22.14.0` for tools that
explicitly require Node.

```bash
bun install --frozen-lockfile
bun run proto:gen
```

Run the workspace checks before starting any component:

```bash
bun run deps:check
bun run docs:check
bun run workflows:check
bun run toolchain:check
bun run proto:check
bun run lint
bun audit
cd shared && bun test --timeout 30000 && bun run typecheck
cd ../implant && bun test --timeout 30000 && bun run typecheck
cd ../server && bun test --timeout 30000 && bun run typecheck
cd ../dashboard && bun run test && bun run build
cd ../octoctl && bun test --timeout 30000 && bun run typecheck
cd ../proxy && bun run typecheck && bun run build
cd ../docs-site && bun run lint && bun run build
cd ../implant && bun run build:all
cd ../server && bun run build
cd ../octoctl && bun run build
cd ../proxy && bun run build
cd .. && bun run smoke:builds
```

## 2. Create role-separated test credentials

Do not reuse credentials across these roles:

1. Controller-to-GitHub credential: `OCTOC2_SERVER_GITHUB_TOKEN`
2. Optional Gist-controller credential: `OCTOC2_SERVER_GIST_TOKEN`
3. Operator REST/SSE credential: `OCTOC2_OPERATOR_API_TOKEN`
4. Per-beacon HTTP/gRPC credentials: `OCTOC2_BEACON_API_TOKENS`
5. Optional direct-dashboard GitHub PAT

The operator token must not appear in the beacon token map. None of the
controller API credentials may equal the GitHub credential.

When Gist is enabled, use two distinct Gist-capable tokens belonging to the
same dedicated GitHub account: the controller token above and a beacon runtime
token supplied as `SVC_GIST_TOKEN`. The Gist controller token must not equal the repository, operator API,
or beacon API credentials.

Generate the operator encryption keypair with the CLI:

```bash
cd octoctl
bun run src/index.ts keygen
```

Keep the secret key out of the repository.

## 3. Start the controller without listeners

Set the required GitHub repository and operator-key variables, then run:

```bash
cd server
bun run src/index.ts
```

HTTP and gRPC remain disabled unless their `*_ENABLED` variables are explicitly
set.

For a loopback-only HTTP evaluation, add:

```text
OCTOC2_HTTP_ENABLED=true
OCTOC2_HTTP_HOST=127.0.0.1
OCTOC2_HTTP_PORT=8080
OCTOC2_HTTP_SERVER_CERT=/absolute/path/to/http-server.crt
OCTOC2_HTTP_SERVER_KEY=/absolute/path/to/http-server.key
# For an internal CA, octoctl also reads:
OCTOC2_HTTP_CA_CERT=/absolute/path/to/http-ca.crt
OCTOC2_OPERATOR_API_TOKEN=<unique operator token>
OCTOC2_BEACON_API_TOKENS={"<full-beacon-id>":"<unique-random-token>"}
OCTOC2_SERVER_URL=https://localhost:8080
```

The HTTP certificate SAN must contain the hostname in `OCTOC2_SERVER_URL`.
Install the issuing CA in the browser and beacon host trust stores. Do not
disable certificate verification; use a publicly trusted certificate or a
locally trusted test CA.

For gRPC, also set `OCTOC2_GRPC_ENABLED=true`, keep
`OCTOC2_GRPC_HOST=127.0.0.1`, provide per-beacon credentials, and configure the
required CA/server certificate and key files. Bind each beacon ID to its
client certificate fingerprint:

```text
OCTOC2_GRPC_CLIENT_CERT_FINGERPRINTS={"<full-beacon-id>":"<SHA-256 fingerprint>"}
```

The server uses `OCTOC2_GRPC_CA_CERT`, `OCTOC2_GRPC_SERVER_CERT`, and
`OCTOC2_GRPC_SERVER_KEY`. Each beacon uses `SVC_GRPC_CA_CERT`,
`SVC_GRPC_CLIENT_CERT`, `SVC_GRPC_CLIENT_KEY`, and the matching
`SVC_BEACON_API_TOKEN`.

Obtain the fingerprint with
`openssl x509 -in beacon-client.crt -noout -fingerprint -sha256`. The
fingerprint map must have exactly the same keys as
`OCTOC2_BEACON_API_TOKENS`, and every fingerprint must be unique. The
controller refuses to start on a missing, extra, malformed, or reused binding.
Do not expose plaintext or unauthenticated gRPC.

Direct gRPC requires no GitHub credential. Codespaces API/SSH mode also
requires a protected runtime `SVC_CODESPACES_GITHUB_TOKEN` with the necessary
user-level Codespaces access: use a classic PAT with only the `codespace` scope,
because fine-grained PATs do not supply GitHub CLI tunnel metadata. Do not use an App installation lease for that
user-level API, and do not bake this token into the beacon. Install GitHub CLI
(`gh`) on the beacon host; Codespaces forwarding uses its authenticated
connection service and never treats the PAT as an SSH password.

## 4. Start the local dashboard

```bash
cd dashboard
bun run dev
```

Open `http://127.0.0.1:5173`.

- Live mode uses only the operator API token for controller HTTPS/SSE calls.
- Direct GitHub mode uses only the GitHub PAT.
- The optional operator private key is used for result decryption.
- All three values stay in memory and are cleared on logout or tab close.

## 5. Explore the operator CLI

```bash
cd octoctl
bun run src/index.ts --help
```

The CLI displays an authorization reminder at startup. Unsigned remote modules
are outside the supported surface: the `module` command is absent and
`task --kind load-module` is rejected.

## 6. Interpret capability status correctly

The repository includes multiple channel implementations. The dashboard’s
channel grid reports recent observations from beacons; it is not a readiness
matrix and does not prove every implementation works end to end.

Before describing any capability as verified, record:

- the exact code revision;
- the isolated environment and credential roles;
- the test command and result;
- the transport actually observed;
- cleanup of test artifacts and credentials.

## 7. Treat the E2E workflow as a prerequisite gate

The protected `octoc2-live-e2e` workflow is manually dispatched. It builds a
fresh, pre-enrolled beacon artifact and validates the declared repository,
credential, recovery, proxy, and optional mTLS configuration. It does not start
the controller or beacon, execute a task, or establish live E2E success.

The required topology is:

- one isolated private C2 repository, which is also the proxy control
  repository for this scenario;
- one separate private proxy decoy repository;
- one separate public recovery repository;
- one full pre-enrolled beacon identity whose public artifact is directly
  importable from `OCTOC2_ENROLLMENT_DIR`;
- distinct controller GitHub, operator GitHub, operator API, per-beacon API,
  recovery-writer, and proxy-dispatch credentials;
- server-only GitHub App and recovery-signing private keys.

No GitHub App private key, shared GitHub credential, or static proxy credential
may be placed in the beacon environment or binary.

To inspect the local fail-closed behavior without querying GitHub:

```bash
bun run scripts/test-end-to-end.ts --dry-run
```

This command still requires the complete declarations and local files. Missing
prerequisites are reported explicitly and produce a nonzero exit code. Add
`--check-github` only in the approved protected environment. Add `--grpc` or
`--http` whenever those transports appear in the recovery priority so their
security prerequisites are validated.

Any later live execution is a separate, explicitly authorized manual exercise.
Record the exact revision, observed transport, task/result evidence, artifact
cleanup, and credential revocation before using the term "Live E2E verified."
See [Deployment and assurance limits](PRODUCTION.md) for the full environment
contract.

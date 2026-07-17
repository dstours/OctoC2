# Quickstart

This quickstart takes a fresh checkout to a pre-enrolled beacon and an accepted
`ping` result through a private GitHub Issues channel. It keeps direct network
listeners disabled for the first run.

> [!IMPORTANT]
> **Authorized use only.** Use an isolated private repository and only deploy the beacon to a system you
> own or are explicitly authorized to test.

## Before you start

Complete these once:

1. [Install](INSTALLATION.md) Bun `1.3.14` and the repository dependencies.
2. Create a private control repository and configure the least-privilege
   credentials in [GitHub setup](GITHUB_SETUP.md).
3. Decide on a protected local directory for controller state, enrollment
   artifacts, and secrets.

For the Issues baseline you need:

- a controller GitHub credential scoped to the control repo with Metadata read
  and Issues read/write;
- an independently scoped beacon GitHub credential or a valid narrowed App
  installation-token lease;
- an operator X25519 keypair;
- the same private owner/repo coordinates on controller and beacon.

## Guided setup

The wizard is the recommended first-run path:

```bash
cd OctoC2
bun run octoctl/src/index.ts setup
```

It walks through credentials, validation, key generation, authentication,
channel selection, environment generation, pre-enrolled beacon compilation,
CLI installation, and verification. Review every proposed repository and
credential role before accepting it.

You can revisit one phase later:

```bash
bun run octoctl/src/index.ts setup --phase validate
```

The remainder of this guide shows the equivalent lifecycle so you can verify
the wizard's output or configure manually.

## 1. Generate the operator key

```bash
cd octoctl
bun run src/index.ts keygen
```

Store the secret as `OCTOC2_OPERATOR_SECRET` in the protected controller
environment. Set the public value as the control repository Actions variable
`MONITORING_PUBKEY`, or let the CLI do it with a direct operator token:

```bash
bun run src/index.ts keygen --set-variable
```

Do not regenerate this key between build and first run.

## 2. Build and enroll a beacon

From the repository root, with `OCTOC2_REPO_OWNER` and
`OCTOC2_REPO_NAME` set:

```bash
bun run octoctl/src/index.ts build-beacon \
  --outfile ./out/beacon \
  --target bun-darwin-arm64 \
  --tentacle-priority issues
```

Choose the target that matches the authorized endpoint:

- `bun-linux-x64`
- `bun-linux-arm64`
- `bun-windows-x64`
- `bun-darwin-arm64`
- `bun-darwin-x64`

Full mode writes both the binary and a public enrollment artifact named
`<outfile>.enrollment.json`. The artifact contains public enrollment material,
not the beacon's runtime PAT, but still belongs in the protected operator
workflow.

Set `OCTOC2_ENROLLMENT_DIR` on the controller to the directory containing that
artifact. The controller must import it before the beacon connects.

## 3. Configure the controller

Create a protected dotenv file outside Git tracking:

```dotenv
OCTOC2_SERVER_GITHUB_TOKEN=<controller-repository-token>
OCTOC2_REPO_OWNER=<owner>
OCTOC2_REPO_NAME=<private-control-repo>
OCTOC2_OPERATOR_SECRET=<operator-x25519-secret>
OCTOC2_DATA_DIR=<absolute-private-data-directory>
OCTOC2_ENROLLMENT_DIR=<absolute-enrollment-directory>
```

The repository credential, operator secret, and beacon credential are
different roles. Do not place the controller token in the beacon environment.

Start the controller:

```bash
bun run octoctl/src/index.ts start server --env /secure/path/octoc2.env
```

Or run it in the foreground after loading the same environment:

```bash
cd server
bun run src/index.ts
```

Confirm the startup log reports one imported enrollment artifact, the expected
owner/repo, and disabled HTTP/gRPC listeners. The Issues, Branch, Actions,
Secrets, Pages, Stego, and Notes controller pollers start against the configured
repo; the beacon priority determines which channel it uses.

## 4. Start the beacon

Transfer the compiled binary to the authorized endpoint through an approved
path. Supply only its runtime role configuration:

```bash
export SVC_GITHUB_TOKEN='<beacon-repository-token>'
export OCTOC2_REPO_OWNER='<owner>'
export OCTOC2_REPO_NAME='<private-control-repo>'
export SVC_TENTACLE_PRIORITY='issues'
chmod 700 ./beacon
./beacon
```

Use a protected service environment on Windows rather than shell `export`.
Never pass a PAT as a command-line argument. The first successful check-in must
match the pre-enrolled ID and signing public key.

## 5. Verify the first task/result

List the beacon from controller state:

```bash
bun run octoctl/src/index.ts beacons
```

Queue a harmless task:

```bash
bun run octoctl/src/index.ts task <full-beacon-id> --kind ping --tentacle issues
```

Then retrieve the accepted result:

```bash
bun run octoctl/src/index.ts results <full-beacon-id> --last 1 --json
```

The run is complete when all of these are observed for the same task ID:

1. controller queues a validated task for the enrolled beacon;
2. encrypted task comment is published;
3. beacon receives and executes `ping` once;
4. beacon publishes a signed and encrypted result;
5. controller verifies and accepts the result;
6. beacon receives or observes result acceptance.

Successful registration by itself is not sufficient.

## 6. Add the dashboard or direct listeners

The dashboard requires the controller's opt-in HTTPS API. Configure trusted TLS,
the operator API token, and the exact beacon bearer map before enabling it. Use
the complete [Configuration](CONFIGURATION.md#https-and-operator-api) and
[Dashboard](../dashboard/README.md) guides, then:

```dotenv
OCTOC2_HTTP_ENABLED=true
OCTOC2_HTTP_HOST=127.0.0.1
OCTOC2_HTTP_SERVER_CERT=<absolute-server-cert-path>
OCTOC2_HTTP_SERVER_KEY=<absolute-server-key-path>
OCTOC2_HTTP_CA_CERT=<absolute-ca-cert-path>
OCTOC2_OPERATOR_API_TOKEN=<unique-operator-bearer>
OCTOC2_BEACON_API_TOKENS={"<exact-beacon-id>":"<unique-beacon-bearer>"}
```

```bash
cd dashboard
bun run dev
```

Open `http://127.0.0.1:5173`. Keep both Vite and the controller on loopback for
local operation.

For gRPC/mTLS, Codespaces, OIDC, proxy, Gist, and other GitHub artifact paths,
follow the exact prerequisites in [Channels](CHANNELS.md). Qualify one channel
at a time with `ping` before adding it to a failover list.

## 7. Stop and clean the test

```bash
bun run octoctl/src/index.ts stop
```

Stop the beacon separately. Inventory and remove only artifacts created by the
test: issue comments/issues, transport branches/files, variables, deployments,
Gists, notes refs, proxy workflow artifacts, and temporary binaries. Preserve
controller/beacon state if the enrollment will be used again.

Do not delete or revoke PATs unless the approved cleanup plan explicitly calls
for credential revocation. Artifact cleanup and credential lifecycle are
separate decisions.

## Next steps

- [Architecture](ARCHITECTURE.md) explains identity and result acceptance.
- [Configuration](CONFIGURATION.md) lists listener, lifecycle, beacon, OIDC,
  dashboard, and recovery variables.
- [Channels](CHANNELS.md) covers every transport and permission.
- [CLI](CLI.md) documents all operator commands.
- [Troubleshooting](TROUBLESHOOTING.md) maps common log messages and API errors
  to safe checks.
- [Operations and assurance](PRODUCTION.md) is the deployment checklist.

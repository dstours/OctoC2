# Installation

This guide installs the OctoC2 controller, dashboard, CLI, and beacon build
tooling from source. Complete [GitHub setup](GITHUB_SETUP.md) before attempting
an end-to-end run.

> [!IMPORTANT]
> **Authorized use only.** Use OctoC2 only on systems and repositories you own or are explicitly
> authorized to test. Keep test repositories private and listener surfaces
> private unless an approved test requires otherwise.

## Requirements

| Requirement | Version or purpose |
|---|---|
| [Bun](https://bun.sh/docs/installation) | `1.3.14` (the pinned package manager and runtime) |
| Git | Clone, update, and Git Notes transport operations |
| Node.js | `22.14.x` only for tooling that explicitly invokes Node |
| GitHub CLI | Required only for Codespaces discovery and SSH tunneling |

Use the exact Bun version. The lockfile, CI, native tests, compiled binaries,
and dependency-policy checks are qualified against that version.

## Install the repository

```bash
git clone https://github.com/dstours/OctoC2.git
cd OctoC2
bun install --frozen-lockfile
bun run proto:gen
bun run deps:check
bun run docs:check
```

`--frozen-lockfile` prevents an install from silently changing the dependency
graph. `proto:gen` produces the checked-in protocol bindings used by gRPC.

## Run components from source

Open separate terminals from the repository root:

```bash
# Controller
cd server
bun run src/index.ts
```

```bash
# Dashboard
cd dashboard
bun run dev
```

```bash
# CLI
cd octoctl
bun run src/index.ts --help
```

The dashboard development server listens on `http://127.0.0.1:5173`. The
controller's HTTP and gRPC listeners remain disabled unless explicitly
configured.

For a shell-friendly CLI command during development, define an alias:

```bash
alias octoctl='bun run --cwd=/absolute/path/to/OctoC2/octoctl src/index.ts'
octoctl --help
```

On PowerShell, use a function in the current session:

```powershell
function octoctl { bun run --cwd C:\tools\OctoC2\octoctl src/index.ts @args }
octoctl --help
```

## Build standalone components

```bash
bun run build:server
bun run build:dashboard
bun run build:octoctl
```

Default outputs are written to each workspace's `dist/` directory. The server
and CLI package scripts currently target Linux x64. Run the CLI from source on
other operator platforms unless you intentionally change and verify its Bun
compile target.

### Build a beacon

The implant workspace provides the supported compile targets:

| Target | Command | Output |
|---|---|---|
| Linux x64 | `bun run build:linux-x64` | `dist/beacon-linux-x64` |
| Linux arm64 | `bun run build:linux-arm64` | `dist/beacon-linux-arm64` |
| Windows x64 | `bun run build:windows-x64` | `dist/beacon-windows-x64.exe` |
| macOS Apple silicon | `bun run build:darwin-arm64` | `dist/beacon-macos-arm64` |
| macOS Intel | `bun run build:darwin-x64` | `dist/beacon-macos-x64` |

```bash
cd implant
bun run build:darwin-arm64
```

The compiled beacon contains the Bun runtime; the target VM does not need Bun.
Transfer it through an approved path, make it executable on Unix-like systems,
and supply runtime secrets through the VM environment:

```bash
chmod 700 ./beacon-macos-arm64
./beacon-macos-arm64
```

For a pre-enrolled build with a generated identity and explicit transport
settings, use `octoctl build-beacon`. See [CLI reference](CLI.md#build-beacon)
and never bake PATs, bearer tokens, private App keys, or recovery signing keys
into the binary.

## Directory map

| Path | Purpose |
|---|---|
| `implant/` | Beacon runtime and platform builds |
| `server/` | Controller, durable state, GitHub channel pollers, HTTP, and gRPC |
| `dashboard/` | Local operator web interface |
| `octoctl/` | Operator CLI and provisioning workflows |
| `shared/` | Canonical task, channel, envelope, and identity contracts |
| `proxy/` | Relay workflow implementation and tests |
| `templates/proxy/` | Files provisioned into control and decoy repositories |
| `docs-site/` | Public documentation landing site |

## Verify the installation

Run the repository-level policy checks first:

```bash
bun run deps:check
bun run docs:check
bun run workflows:check
bun run toolchain:check
bun run proto:check
```

Then run workspace tests and type checks from each changed workspace:

```bash
cd shared && bun test --timeout 30000 && bun run typecheck
cd ../implant && bun test --timeout 30000 && bun run typecheck
cd ../server && bun test --timeout 30000 && bun run typecheck
cd ../dashboard && bun test --timeout 30000 && bun run typecheck
cd ../octoctl && bun test --timeout 30000 && bun run typecheck
```

Continue with the [quickstart](QUICKSTART.md) to configure credentials, enroll a
beacon, and verify a harmless `ping` task.

## Update an installation

Stop running components, preserve the controller data directory, and then:

```bash
git pull --ff-only
bun install --frozen-lockfile
bun run proto:check
bun run docs:check
```

Review release changes before rebuilding beacons. Do not replace an enrolled
beacon identity, controller database, or recovery generation as an incidental
part of a source update.

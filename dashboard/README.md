# OctoC2 Operator Dashboard

React + Vite operator UI for the OctoC2 framework.

> **OPSEC:** The dashboard is intentionally **never deployed to GitHub Pages or any public URL.**
> It runs locally or inside a private GitHub Codespace only.

---

## Quick Start

### Local (recommended)

```bash
cd dashboard
bun install
bun run dev
```

Opens at **http://localhost:5173**

Or from the repo root:

```bash
bun run dashboard:dev
```

### GitHub Codespace

Open this repo in a private GitHub Codespace — the dashboard starts automatically on port 5173 and opens in your browser via port forwarding.

---

## Connecting

| Mode | What you need | What works |
|------|--------------|------------|
| **Live** | Operator server running + PAT | Full task queue, results, maintenance |
| **API** | GitHub PAT only | Read beacons from GitHub Issues |
| **Offline** | Nothing | Browse cached data only |

Enter your **GitHub PAT** (`repo` scope) on the login page. Optionally enter your **operator private key** (base64url) to auto-decrypt beacon results.

Credentials are held **in memory only** — never written to disk or localStorage.

---

## Development

```bash
bun run test          # Run all 236 tests (watch mode)
bun run test --run    # Run once (CI mode)
bun run build         # Production build → dist/
bun run lint          # ESLint
```

## Stack

- React 18 + Vite 8
- shadcn/ui + Tailwind CSS (dark cyberpunk theme)
- TanStack Query v5
- React Router v6
- Vitest + @testing-library/react

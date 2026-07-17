# OctoC2 Operator Dashboard

> [!IMPORTANT]
> **Authorized use only.** Run this UI on trusted loopback or a reviewed private
> network for systems and repositories you have explicit permission to test.

## Local development

```bash
cd dashboard
bun run dev
```

Vite binds to `127.0.0.1:5173` and proxies `/api` to
`https://127.0.0.1:8080`.

The controller is TLS-only. Configure `OCTOC2_HTTP_SERVER_CERT` and
`OCTOC2_HTTP_SERVER_KEY`, and trust the issuing local CA in the operating
system or browser running the dashboard. The Vite proxy verifies the
controller certificate and does not include a certificate-verification
bypass.

When setting `VITE_C2_SERVER_URL`, use a bare HTTPS origin such as
`https://127.0.0.1:8080`. HTTP URLs and values containing userinfo, a path,
query string, or fragment are rejected before the dashboard sends any request.

The devcontainer does not auto-start the dashboard. Start it explicitly, and
keep any Codespaces port forwarding private.

## Credential roles

The login page intentionally separates:

- **Operator API Token** — sent only to controller REST/SSE routes in live mode.
- **GitHub PAT** — sent only to GitHub in direct API fallback mode.
- **Operator Private Key** — used locally for result decryption.

Credentials remain in React memory. They are not persisted to browser storage,
and logout clears all roles. A GitHub PAT is never substituted for the operator
token.

## Capability display

The channel page is an activity view. “Recently observed” means a beacon
reported recent use of a catalog entry; it does not prove transport readiness
or live E2E coverage.

Unsigned remote module execution is not part of the dashboard surface.
`load-module` does not appear in task selectors or bulk controls.

## Verification

```bash
bun test --timeout 30000
bun run lint
bun run build
```

The build runs strict TypeScript checking before Vite produces `dist/`.

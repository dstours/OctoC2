# Development Guide

OctoC2 is a Bun/TypeScript monorepo with strict shared contracts. Behavior
changes should update the canonical catalog or schema first, then every
producer, consumer, test, and guide affected by that contract.

> [!IMPORTANT]
> **Authorized use only.** Keep development fixtures isolated and never commit
> live credentials, private-repository content, host data, or personal data.

## Workspaces

| Workspace | Entry point | Test command |
|---|---|---|
| `shared/` | library exports | `bun test --timeout 30000` |
| `implant/` | `src/index.ts` | `bun test --timeout 30000` |
| `server/` | `src/index.ts` | `bun test --timeout 30000` |
| `dashboard/` | `src/main.tsx` | `bun test --timeout 30000` |
| `octoctl/` | `src/index.ts` | `bun test --timeout 30000` |
| `proxy/` | workflow/runtime sources | `bun test --timeout 30000` |
| `docs-site/` | `src/main.tsx` | `bun run lint && bun run build` |

Run `bun run typecheck` in each TypeScript workspace. Strict mode and
`exactOptionalPropertyTypes` are enabled; conditionally spread optional
properties instead of assigning `undefined`.

## Toolchain and install

Use Bun `1.3.14`, the checked-in lockfile, and the declared Node 22.14 tooling
range:

```bash
bun install --frozen-lockfile
bun run toolchain:check
bun run deps:check
```

Do not update one workspace's dependency independently when the package is
centrally pinned or overridden at the root.

## Repository checks

```bash
bun run proto:check
bun run docs:check
bun run workflows:check
bun run toolchain:check
bun run lint
bun audit
```

`docs:check` validates consistency-sensitive claims. `workflows:check` verifies
that Actions dependencies are commit-pinned. `proto:check` ensures generated
gRPC bindings match their source.

## Protocol changes

Canonical channel definitions live in `shared/src/channels.ts`; task schemas
and risk classification live in `shared/src/tasks.ts`. Signed envelope and
identity changes also belong in `shared/`.

When changing a wire contract:

1. Update its canonical shared type and untrusted-input validator.
2. Add shared positive and negative tests.
3. Update controller and beacon producers/consumers together.
4. Preserve version/replay behavior or add an explicit migration.
5. Regenerate protocol bindings with `bun run proto:gen` if the protobuf changes.
6. Update CLI/dashboard choices and these guides.

Never make one transport accept a broader payload than the shared contract.

## Adding or changing a task

Update the shared task catalog, its exact argument validator and risk level,
the implant `TaskExecutor` handler, the server/operator surfaces, and tests for
unknown fields, range limits, timeouts, and result metadata. Destructive tasks
must be explicit and must not be selected through a generic fallback.

Remote module loading is deliberately absent. Do not reintroduce arbitrary
unsigned module execution under a new task alias.

## Adding or changing a channel

1. Add or update the canonical catalog entry and prerequisites.
2. Implement both implant tentacle and controller counterpart.
3. Register the implant through `registerTentacles.ts` so initial boot and
   recovery rebuild remain consistent.
4. Use the shared token getter for repository App leases.
5. Define result-acceptance behavior, cursor scope, artifact ownership, replay
   handling, teardown, and cleanup.
6. Add unit tests, a local integration path, and an authorized live
   qualification plan.
7. Update [Channels](CHANNELS.md), [GitHub setup](GITHUB_SETUP.md), and the
   traceability record without overstating the evidence level.

Catalog presence is not proof of readiness. Keep incomplete paths selectable
only when their prerequisites and limitations are explicit; keep missing
counterparts unavailable.

## Testing patterns

- Use `bun:test`, not Jest or Vitest.
- Restore environment variables and module mocks after each test.
- When `mock.module()` arrays are indexed, cast through `as any` if required to
  avoid TypeScript tuple-index inference errors.
- Prefer deterministic clocks, IDs, and in-memory or temporary state roots.
- Test malformed, stale, cross-beacon, replayed, and unauthorized envelopes in
  addition to the success path.
- Verify hard-ceiling timeout branches terminate child processes.
- Preserve the dashboard's isolated test runner to avoid module-mock leakage.

## Builds

```bash
bun run build:server
bun run build:dashboard
bun run build:octoctl
cd implant && bun run build:all
```

For a normal behavior change, test the affected target plus its shared
contracts. Use `bun run smoke:builds` when a change can affect compile targets,
native dependencies, or runtime startup.

## Documentation standards

- Make the Markdown guides authoritative; keep the docs site as a concise map.
- Link to implementation status rather than claiming a transport is universally
  available.
- Keep local, integration, and live evidence labels distinct.
- Use placeholder credentials only. Never paste `.env` contents, private repo
  data, PAT fragments, hostnames, usernames, or live artifact payloads.
- Link current external setup claims to official GitHub documentation.
- Run `bun run docs:check` and validate relative links after edits.

## Change checklist

- [ ] Scope is limited to the requested behavior.
- [ ] No secret, PII, private URL, credential fragment, or generated state is in
  the diff.
- [ ] Shared contracts and generated bindings agree.
- [ ] Changed workspaces pass tests and strict TypeScript checks.
- [ ] Security-relevant failure cases have regression coverage.
- [ ] Documentation, CLI help, dashboard choices, and channel/task catalogs
  agree.
- [ ] Workflow actions remain commit-pinned.
- [ ] Live test artifacts are inventoried and cleaned when live testing occurs.
- [ ] The commit contains no local research notes or unrelated workspace files.

For release-level assurance and stop conditions, use [Operations and
assurance](PRODUCTION.md) and [Remediation traceability](REMEDIATION_TRACEABILITY.md).

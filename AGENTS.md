<!-- AGENTS.md — Agent-focused guidance for OctoC2 -->

# Agent Instructions for OctoC2

## Project Overview

OctoC2 is a GitHub-native command-and-control framework. The beacon (implant) and server communicate exclusively through GitHub's public API. All payloads are encrypted with libsodium `crypto_box` / `crypto_box_seal`.

## Workspaces

| Workspace | Path | Test command |
|-----------|------|--------------|
| Implant | `implant/` | `bun test` |
| Server | `server/` | `bun test` |
| Dashboard | `dashboard/` | `bun test` |
| CLI | `octoctl/` | `bun test` |

Run TypeScript checks: `bun run tsc --noEmit` (from each workspace directory).

## Core Architecture

### Implant
- **Entry:** `implant/src/index.ts` — bootstraps `ConnectionFactory`, starts main loop
- **ConnectionFactory:** `implant/src/factory/ConnectionFactory.ts` — tentacle health, failover, dead-drop recovery
- **Tentacles:** `implant/src/tentacles/` — 11 channels (issues, gist, branch, pages, actions, codespaces, secrets, notes, steganography, http, oidc)
- **TaskExecutor:** `implant/src/tasks/TaskExecutor.ts` — dispatches task kinds to handlers
- **DeadDropResolver:** `implant/src/recovery/DeadDropResolver.ts` — last-resort config recovery via GitHub search

### Server
- **Entry:** `server/src/index.ts` — initializes registry, task queue, channels, gRPC, HTTP
- **BeaconRegistry:** `server/src/BeaconRegistry.ts` — in-memory beacon state with debounced JSON persistence
- **TaskQueue:** `server/src/TaskQueue.ts` — per-beacon in-memory queues with O(1) task lookups
- **Channels:** `server/src/channels/` — server-side polling loops for each tentacle type

## Recent Changes (merged to main)

### DRY & Code Quality (PR #5)
- **Centralized tentacle registration:** `implant/src/factory/registerTentacles.ts` handles all 12 tentacle kinds. Used by both initial boot and dead-drop rebuild.
- **Shared token getter:** `getSharedTokenGetter(config)` in `implant/src/lib/AppTokenManager.ts` returns a singleton-cached token getter keyed by `appId|installationId`.
- **`GH_UA` constant:** `implant/src/lib/constants.ts` is the single source of truth for the GitHub CLI user-agent string.

### Security Hardening (PR #1)
- **Shell task metadata:** `shell` tasks set `result.metadata = { shellInvoked: true }` so operators can distinguish shell vs exec execution.
- **Safer `selfDelete()`:** Compares `process.argv[1]` against `process.execPath`. Skips deletion if running via interpreter (`bun run`, etc.).
- **ModuleLoader hardening:**
  - `MAX_MODULE_SIZE = 10MB` — rejects oversized modules
  - Temp files use `crypto.randomUUID()` instead of predictable names
  - `chmod 0o700` on all temp payloads
- **Zombie process prevention:** `TaskExecutor.runProcess()` explicitly `proc.kill("SIGKILL")` in the hard-ceiling timeout branch.

### Reliability (PR #3)
- **Teardown resets bootstrap flag:** `ConnectionFactory.teardown()` sets `this.bootstrapped = false` so the next initialization shows `[bootstrap]` logs.
- **Transient error retry:** `IssuesTentacle` classifies 5xx/timeout/network errors as transient (5-minute retry cooldown). 401/403 remain fatal.
- **Shared `AppTokenManager`:** `getSharedTokenGetter()` deduplicates token managers across tentacle instances.

### Server Performance (PR #4)
- **TaskQueue O(1) indexes:** Added `taskIndex: Map<string, QueuedTask>` and `refIndex: Map<string, QueuedTask>`. `getTask()` and `getTaskByRef()` are now O(1) instead of O(n²).
- **BeaconRegistry debounced persist:** `register()` triggers a 1-second trailing-edge debounce. Rapid successive registrations coalesce into a single disk write. `shutdown()` flushes pending writes.

## Coding Conventions

- **TypeScript strict mode** is enabled. `tsc --noEmit` must pass before committing.
- **Bun native test runner** — use `bun:test`, not jest/vitest. `mock.module()` for module-level mocking.
- **`exactOptionalPropertyTypes`** is on. Use spread conditionally (`...(cond && { prop })`) instead of setting `prop: undefined`.
- **Test mocks:** When `mock.module()` returns arrays that code accesses by index, cast through `as any` to avoid TS2493 tuple errors.
- **No secrets in source:** Keys and tokens come from env vars, dead-drops, or runtime config only.

## Testing Expectations

Before committing behavior changes:
1. Run workspace-specific tests: `bun test --timeout 30000`
2. Run TypeScript check: `bun run tsc --noEmit`
3. If you change logic, add or update tests for the touched module.

## Restarting the Server

```bash
# Quick restart (code already running)
bun run server/src/index.ts

# After code changes
cd server && bun run src/index.ts
```

The server auto-saves beacon registry to `./data/registry.json` on shutdown and every 5 minutes.

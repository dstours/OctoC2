# Troubleshooting

> [!IMPORTANT]
> **Authorized use only.** Diagnose only systems and repositories included in
> the approved test boundary, and redact sensitive data from every artifact.

Start with a harmless `ping`, one channel, and `OCTOC2_LOG_LEVEL=debug`. Record
timestamps from controller and beacon logs, but redact credentials, private
keys, authorization headers, repository URLs that identify a private customer,
hostnames, and usernames before sharing diagnostics.

## First checks

```bash
octoctl status
octoctl beacons --json
octoctl tentacles list --beacon <id-prefix> --verbose
octoctl results <beacon-id> --last 3 --json
```

Confirm system clocks are synchronized, the exact beacon ID matches the
enrollment, and the configured channel appears in the beacon's startup log.

## Startup failures

| Symptom | Likely cause | Check or fix |
|---|---|---|
| Missing required configuration | Repository, operator key, credential, or recovery bootstrap is incomplete | Run `octoctl setup --phase validate`; compare with [Configuration](CONFIGURATION.md) |
| Operator secret has invalid length | Wrong encoding or wrong key role | Regenerate with `octoctl keygen`; use the base64url X25519 secret |
| No pre-provisioned identity | Beacon was compiled in simple mode or state was removed | Build/enroll with full `octoctl build-beacon`; do not invent key fields |
| Provisioned identity does not match state | A binary/state directory from different enrollments was combined | Restore the matching pair; never overwrite identity checks |
| Both static token and lease configured | Ambiguous GitHub authority | Set exactly one of `SVC_GITHUB_TOKEN` and `SVC_GITHUB_TOKEN_LEASE` |
| App private key rejected on beacon | Server-only secret was placed on endpoint | Remove it from the endpoint; mint narrowed leases on the controller |
| Listener fails immediately | Invalid port, missing TLS files, unreadable key, or occupied port | Validate paths/permissions and inspect the named bind address |

## GitHub API errors

### `404 Not Found`

For private repositories GitHub often returns `404` when the credential cannot
see the repository. Check the credential's resource owner, selected repository,
App installation, and expiration before assuming the artifact is missing. Also
confirm the issue/comment/branch/ref still exists and that owner/repo case is
correct.

### `401 Unauthorized`

The credential is absent, malformed, revoked, or expired. A short-lived App
lease may have expired; use the proactive recovery publisher or provision a new
lease. Do not substitute a different credential role merely to make the call
succeed.

### `403 Forbidden`

The identity is recognized but lacks the required permission, is blocked by an
organization policy, or hit a rate/abuse limit. Compare the channel with the
[permission matrix](GITHUB_SETUP.md#repository-permissions), inspect GitHub's
response headers, and wait only when the failure is actually rate-related.

## Issues and proxy symptoms

### Registration succeeds, but comments return 404

Registration only proves one API path worked. Verify the token can read and
write comments on the exact configured issue, and that the controller watches
the same owner/repo/issue scope. For proxy, inspect both the decoy issue and the
control-side relay artifact.

### `failed to decrypt task comment`

The comment may be a registration acknowledgement/result rather than a task,
may belong to another beacon, may be malformed, or may have been sealed with a
different operator/beacon key. Confirm `MONITORING_PUBKEY`, enrollment keys,
beacon ID, route issue number, and recovery generation. Do not weaken parsing
to accept an ambiguous payload.

### `payload is neither a task array nor registration ack`

An unrelated/stale comment was read or the two route endpoints disagree about
the envelope version. Confirm artifact scoping and deploy the same revision to
beacon, controller, and proxy workflows. Remove stale test artifacts only after
capturing the evidence needed to diagnose them.

### Result acknowledgement timeout

An artifact write is not the same as controller acceptance. Look for the result
in controller logs and inspect signature, ownership, task state, replay, and
result-digest rejection messages. Confirm the acknowledgement is returned on
the same issue/route. Increase `SVC_RESULT_ACK_TIMEOUT_MS` only when acceptance
eventually succeeds and measured queue latency exceeds the current window.

### Proxy fails while Issues works

Check that control and decoy are distinct, both workflows are present and
enabled, repository-dispatch secrets target the correct opposite repository,
the App installation includes the decoy, route signatures/fingerprints match,
and the signed recovery policy contains the current route. Inspect Actions logs
on both repos without printing secret values.

## Direct transport symptoms

### Certificate verification or hostname failure

Use the hostname present in the server certificate SAN. Verify the configured
CA file, certificate chain, validity dates, and target clock. There is no
supported insecure TLS switch.

### HTTP returns 401/403

The dashboard/CLI uses `OCTOC2_OPERATOR_API_TOKEN`; a beacon uses the token
mapped to its exact ID in `OCTOC2_BEACON_API_TOKENS`. Do not interchange them.
Credentials belong in authorization headers, never query strings.

### gRPC cannot connect

Confirm the listener is enabled, port is reachable, the client trusts the
server CA, the server trusts the client CA, the beacon certificate fingerprint
matches the exact ID, and the per-beacon bearer is present. A Dev Tunnels HTTPS
URL is not a raw gRPC endpoint.

### Codespaces discovery or SSH fails

Run `gh auth status` under the same OS user, verify the dedicated classic PAT
has `codespace`, confirm the named Codespace belongs to/permits that account,
and test approved SSH access. Deep-sleep/stopped Codespaces may need to start
before discovery completes. Auto-provisioning occurs only when explicitly
enabled.

## OIDC rejection

Compare the token claims to `OCTOC2_OIDC_BINDINGS`: repository, subject,
workflow ref, audience, and exact beacon ID. Confirm the workflow has
`permissions: id-token: write`. Ref or reusable-workflow changes can alter
claims. Do not add wildcards to bypass a mismatch.

## State and recovery

| Symptom | Check |
|---|---|
| Beacon appears under a new ID | Wrong/empty state directory or non-enrolled build |
| Task repeats after restart | Preserve the beacon ledger and controller database; inspect replay-retention changes |
| Recovery record ignored | Signature/key ID, recipient ID, generation monotonicity, expiry, repo/ref, and complete policy |
| Recovered token works on wrong repo | Treat as a policy failure; stop testing and inspect App installation/policy narrowing |
| Controller loses history | Restore the whole configured data directory, not selected JSON/SQLite files |

## Dashboard

- Blank API data: verify `VITE_C2_SERVER_URL` is a bare HTTPS origin and the
  controller HTTP listener is enabled.
- Browser certificate warning: trust the issuing internal CA in the browser/OS;
  do not disable verification in Vite.
- Login succeeds in GitHub mode but live actions fail: GitHub PAT and operator
  API token are separate roles.
- CORS rejection: set the reviewed `OCTOC2_DASHBOARD_ORIGIN` to the exact UI
  origin.

## Development and CI

Run the narrowest failing workspace first:

```bash
bun test --timeout 30000
bun run typecheck
```

Then run repository policy checks from the root. If dashboard tests leak mocks
or DOM state, use its isolated `src/testRunner.ts` rather than replacing it with
a generic root test invocation. If `proto:check` fails, regenerate bindings and
review the diff instead of editing generated files manually.

## Safe live-test sequence

1. Record the exact commit and channel.
2. Confirm private repository and credential scope.
3. Start controller, then beacon, and wait for an authenticated registration.
4. Submit one `ping` forced through the named channel.
5. Record publication, receipt, signed result, and controller acceptance.
6. Remove test issues/comments, refs, variables, deployments, Gists, images,
   notes, and workflow artifacts created by the run.
7. Confirm normal non-test content remains.
8. Retain or revoke PATs only according to the explicit credential cleanup
   decision; artifact cleanup does not authorize token deletion.

Stop immediately if a route reaches an unapproved repository, a credential has
wider access than intended, plaintext secret/PII appears in an artifact or log,
or identity/ownership verification is bypassed.

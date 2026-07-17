# Proxy relay workflow contract

> [!IMPORTANT]
> **Authorized use only.** Exercise this relay contract with distinct private
> repositories, scoped credentials, and explicit permission for every account
> and repository involved.

These workflows require two distinct repositories:

- a decoy repository containing `helper.yml` and `sync-helper.yml`;
- a control repository containing `process-checkin.yml` and
  `forward-replies.yml`.

Ingress and egress are separate events. The ingress workflow posts the beacon
comment to its mapped control issue exactly once. A later control issue comment
is forwarded by the egress workflow; the ingress job never tries to read a
reply before one can exist.

Every dispatch carries a stable source event ID and an HMAC-SHA256 signature.
Decoy ingress observes both created and edited issue comments and binds the
source event ID to the repository ID, comment ID, and SHA-256 body digest, so
each updated Issues check-in is relayable while duplicate deliveries remain
idempotent. Hidden `octoc2-relay` markers prevent loops and duplicate comments.
Receiver workflows serialize duplicate dispatches by the source event ID.

Required configuration:

- both repositories: `RELAY_SIGNING_KEY` (the same high-entropy secret);
- decoy variables: `FORWARD_ISSUE` and `MONITORING_PUBKEY`; the latter must
  equal the operator key declared by signed recovery;
- decoy GitHub App lease permissions: `metadata:read`, `issues:write`, and
  `variables:read`;
- decoy secrets: `NODE_ID`, `CONTROL_OWNER`, `CONTROL_REPO`, and
  `CONTROL_TOKEN`, where the token is limited to dispatching the control repo;
- control variable: `NODE_ROUTE_MAP`, mapping each node ID to
  `{ "controlIssue": 42, "decoyRepository": "owner/decoy", "decoyIssue": 1 }`;
- control variable: `OCTOC2_PROXY_CONTROL_FINGERPRINTS`, with exact shape
  `{ "version": 1, "relaySigningKeySha256": "<64 lowercase hex>", "targetDispatchTokenSha256": "<64 lowercase hex>" }`
  (never the secret values);
- control secret: a stable `TARGET_TOKEN` limited to dispatching all allowlisted
  decoy repositories that share this control repository.

`NODE_ROUTE_MAP` is keyed by node ID, so each beacon may have at most one proxy
route. Multiple beacons may share a control repository only when they use the
same relay-signing and target-dispatch credentials; provisioning verifies the
stored fingerprints before mutating either repository.

The receiver reconstructs the unsigned payload with `jq -cS` before comparing
the HMAC, enforces a short timestamp window, validates the repository/issue
against `NODE_ROUTE_MAP`, and searches for the stable hidden marker before
posting. No monotonic repository-wide cursor is used, so delayed replies from
different routes cannot be discarded merely because they complete out of order.

A same-repository setup does not exercise the trust boundary and must not be
reported as proxy end-to-end verification.

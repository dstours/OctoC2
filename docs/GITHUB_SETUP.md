# GitHub Setup

OctoC2 uses GitHub repositories as explicit transport boundaries. This guide
defines a least-privilege topology, GitHub App registration, and the separate
credentials used by the controller, operator, beacon, proxy, and recovery
publisher.

GitHub changes its registration UI over time. The field guidance below follows
the current official documentation for [registering a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app),
[choosing App permissions](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app),
and [managing private keys](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps).

> [!IMPORTANT]
> **Authorized use only.** Use dedicated test repositories and accounts. Do not grant organization-wide
> access when selected-repository installation is sufficient.

## Repository topology

| Repository | Visibility | Purpose | Installed App? |
|---|---|---|---|
| Control | Private | Primary GitHub-backed task and result transport | Yes |
| Decoy | Private | Distinct outer repository for the optional proxy route | Yes, when proxy is used |
| Recovery | Public | Signed and sealed dead-drop records discoverable without a working control credential | No; use a dedicated writer token |

Keep control and decoy separate. A proxy route does not create a useful
boundary if both names refer to the same repository. The recovery repository
contains encrypted records and public verification metadata only—never raw
tokens, private keys, hostnames, usernames, or operator notes.

## Register the GitHub App

Create the App under the account or organization that owns the test
repositories:

1. Open **Settings → Developer settings → GitHub Apps → New GitHub App**.
2. Choose a unique, ordinary App name.
3. Set **Homepage URL** to the project repository or owning account URL.
4. Leave **Callback URL** empty. OctoC2 does not request a user access token.
5. Leave **Request user authorization (OAuth) during installation** off.
6. Leave **Enable Device Flow** off.
7. Leave **Expire user authorization tokens** checked. It is GitHub's
   recommended setting and has no effect when user tokens are not requested.
8. Leave **Setup URL** empty and **Redirect on update** off.
9. Under **Webhook**, clear **Active**. OctoC2 polls authenticated APIs and does
   not require a webhook URL, secret, or event subscription.
10. Select **Only on this account** unless an approved deployment requires the
    App to be installable elsewhere.

### Repository permissions

Always retain **Metadata: read-only**. Add only the permissions required by the
channels you enable:

| Channel | Repository permission |
|---|---|
| Issues, proxy inner/outer exchange | Issues: read and write |
| Branch, Git Notes, steganography | Contents: read and write |
| Actions | Actions: read and write; Variables: read and write |
| Secrets (`7b`) | Variables: read and write |
| Pages | Deployments: read and write |

Gists and Codespaces are user-level surfaces and do not use the repository App
installation token. OIDC authenticates with GitHub Actions identity tokens.
Direct HTTP and gRPC use controller credentials and certificates rather than
GitHub repository permissions. The reserved `pull_request` catalog entry is
not selectable.

### Install and record the App identity

After creating the App:

1. Note its numeric **App ID**.
2. Generate a private key and save the downloaded PEM on the controller only.
3. Restrict the file to the controller service account (`chmod 600` on Unix).
4. Install the App using **Only select repositories** and select the control
   repository plus the decoy repository if proxy is enabled.
5. Record the numeric installation ID from the installation settings URL or
   query it through the GitHub API.

The controller exchanges the App JWT for short-lived, repository-restricted
[installation access tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app).
The App private key never belongs on a beacon, in an Actions secret, or in a
recovery record.

## Credential roles

No single PAT needs access to every surface. Create one credential per role and
scope it to the named account and repository.

| Role | Account/repository placement | Minimum access |
|---|---|---|
| Controller repository token | Dedicated controller identity; control repo only | Metadata read plus enabled channel permissions from the table above |
| Operator GitHub token | Operator account; control repo only | Issues read/write and Variables read/write when using direct GitHub dashboard/CLI paths and `MONITORING_PUBKEY` |
| Beacon Gist token | Dedicated Gist account | Classic PAT with `gist` |
| Controller Gist token | Same dedicated Gist account, different token | Classic PAT with `gist` |
| Codespaces runtime token | Account that owns or can access the named Codespace | Classic PAT with `codespace`; do not reuse a repository token |
| Recovery writer | Recovery owner; recovery repo only | Fine-grained Contents read/write (Metadata is implicit) |
| Proxy dispatch token | Exact workflow target repo | Fine-grained Contents write as required for repository dispatch |

GitHub recommends fine-grained PATs when they support the required operation;
see [managing personal access tokens](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens).
Gist and current Codespaces CLI/API paths require their noted user-scoped
classic PATs. A third GitHub account is not inherently required: separation is
by credential role, though a dedicated service account reduces the blast
radius and makes audit attribution clearer.

OctoC2 application credentials are not PATs:

| Credential | Purpose |
|---|---|
| `OCTOC2_OPERATOR_API_TOKEN` | Dashboard/CLI authentication to the controller |
| `OCTOC2_BEACON_API_TOKENS` | Exact beacon ID to bearer-token map for direct transports |
| `OCTOC2_OPERATOR_SECRET` | X25519 secret used to decrypt results and seal tasks |
| Beacon Ed25519 key | Persistent signing identity for check-ins and results |
| Recovery Ed25519 key | Server-only signing identity for dead-drop records |

## Repository variables and secrets

Set `MONITORING_PUBKEY` as an Actions repository variable on every repository
that directly carries encrypted tasks. Its value is the operator's X25519
public key generated by `octoctl keygen`; it is not a secret.

Proxy workflow repositories use the variables and secrets documented in the
[proxy workflow contract](../templates/proxy/README.md). Keep workflow dispatch
tokens in Actions secrets, bind route variables to exact repositories, and do
not reuse the controller or recovery-writer token.

## Validate the setup

Before starting a beacon:

- Confirm the App installation lists only the intended control and decoy repos.
- Compare granted permissions with the enabled channel set.
- Confirm the control and decoy repositories are private.
- Confirm the recovery repository contains no plaintext secrets or personal
  data.
- Verify `MONITORING_PUBKEY` matches the operator secret you will load.
- Verify controller and beacon Gist tokens differ.
- Verify the Codespaces PAT belongs to the account that can open the named
  Codespace.
- Keep every private key and PAT out of Git, logs, screenshots, and compiled
  binaries.

Run `octoctl setup --phase validate` for the CLI's configured checks, then
continue with [configuration](CONFIGURATION.md) and the [quickstart](QUICKSTART.md).

## Rotation

Rotate one role at a time. Update the consuming component, restart it, and
verify a harmless task before revoking the replaced credential. GitHub App
private-key rotation can overlap keys; installation tokens are short-lived and
must be allowed to expire. Recovery signing-key rotation requires a signed key
transition and is covered in [Recovery](RECOVERY.md).

Retain or revoke test PATs according to the operator's explicit cleanup plan.
Repository artifact cleanup does not imply credential deletion.

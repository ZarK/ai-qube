# GitHub provider support

QUBE uses the official GitHub CLI (`gh`) as the API transport for its current
GitHub work, review, CI, setup-source, and label operations. The requirement is
conditional. User-global initialization, local-only work, and repositories that
select no GitHub role do not invoke or require `gh`.

GitHub API credentials and Git remote credentials are separate. A successful
GitHub API probe does not prove that `git fetch` or `git push` can authenticate.

## Install GitHub CLI

Use the official [GitHub CLI installation instructions](https://github.com/cli/cli#installation):

- Windows: install the supported Windows package from the official instructions.
- macOS: install the supported Homebrew or binary package from the official instructions.
- Linux: use the official package repository or binary instructions for the distribution.

Run `gh --version` after installation. QUBE reports `unsupported-version` when
the installed CLI cannot produce the structured authentication result used by
the readiness evaluator.

## When `gh` is required

| Selected behavior | CLI | Credential used |
| --- | --- | --- |
| User-global initialization | Not required or invoked | None |
| No GitHub work, review, CI, setup-source, or pending GitHub action | Not required | None |
| GitHub work and lifecycle | Required | Active stored account or official environment token |
| GitHub CI diagnostics | Required | Active stored account or official environment token |
| Current-user review publication | Required | Active stored account or official environment token |
| Named-token review publication | Required | Configured environment-variable reference; no stored login is required for publication |
| GitHub App review publication | Required | App installation credential; no stored login is required for publication |
| `--from owner/repo`, repository priming, and label setup | Required | Active stored account or official environment token |

An App or named publisher token does not satisfy a separately selected GitHub
work or CI role. QUBE evaluates both credentials for combined configurations.

## Host, account, and credential selection

QUBE derives the host and `owner/repository` identity from the redacted origin
remote or explicit provider connection fields. Stored credentials are checked
with a structured, host-targeted command:

```sh
gh auth status --active --hostname <host> --json hosts
```

The JSON command can exit successfully while its payload reports an
authentication problem. QUBE checks the active account's `state`; it does not
parse localized terminal prose. It never uses `--show-token` or `gh auth token`
for diagnostics.

The official environment-variable precedence is:

- GitHub.com and supported `ghe.com` subdomains: `GH_TOKEN`, then `GITHUB_TOKEN`.
- GitHub Enterprise Server: `GH_ENTERPRISE_TOKEN`, then `GITHUB_ENTERPRISE_TOKEN`.

Readiness output reports only the credential class and safe variable name. It
never reports the value, a private key, an Authorization header, a credential
store path, or a credential-bearing URL.

When several accounts exist for a host, QUBE reports the active account and
never changes it automatically. Select one explicitly:

```sh
gh auth switch --hostname <host> --user <login>
```

Or add a host-specific login with the official interactive flow:

```sh
gh auth login --hostname <host>
```

See the official [`gh auth status`](https://cli.github.com/manual/gh_auth_status),
[`gh auth switch`](https://cli.github.com/manual/gh_auth_switch), and
[`gh auth login`](https://cli.github.com/manual/gh_auth_login) references.

## Capabilities and least privilege

QUBE uses bounded, read-only probes. It does not create, edit, label, comment,
review, merge, rerun, resolve, or delete provider data to test a permission.
When GitHub does not expose a trustworthy read-only permission signal, the write
capability is `unverified`; it is never promoted to `ready` from a scope name or
successful read alone.

| Role or command class | Required capability |
| --- | --- |
| Work queue and issue reads | Repository metadata and Issues read |
| Start, status, dependency, completion, and label changes | Issues write; label changes use the Issues permission |
| Pull-request inspection and lifecycle | Pull requests read; enabled writes or merge actions need their exact repository permission |
| CI diagnostics | Checks read and Actions read when Actions data is used |
| Formal reviews and inline comments | Pull requests read and write |
| Review-thread resolution or minimization | Contents write in the current App implementation; request it only when this behavior is enabled |
| GitHub App publication | App installation on the repository with the listed App permissions |

Classic OAuth scopes, fine-grained token permissions, App permissions,
organization policy, and SSO authorization are different permission systems:

- For a classic token, grant only the scopes needed by the selected commands.
- For a fine-grained token, select the repository and the named repository
  permissions in the table. A classic `repo` scope is not proof of a
  fine-grained permission.
- For a GitHub App, install it only on required repositories and grant Pull
  requests read/write for formal reviews. Add Contents write only for enabled
  thread resolution or minimization.
- If an organization requires SAML SSO, authorize the selected credential for
  that organization. See GitHub's [authentication overview](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/about-authentication-to-github).

Use [`gh auth refresh`](https://cli.github.com/manual/gh_auth_refresh) only when
the selected stored OAuth credential needs a supported additional scope. Do not
replace a least-privilege fine-grained token or App installation with an
oversized classic token as a universal remedy.

## GitHub Enterprise

Stored and official environment-token paths target the host derived from the
repository. REST probes pass `--hostname` to `gh`; SSH and HTTPS remotes are
both parsed without retaining credentials.

GitHub App publication is currently supported only for GitHub.com because its
token-minting stack is not yet host-plumbed end to end. QUBE returns
`host-unresolved` for an App publisher on another Enterprise host and stops
before provider writes. User and named-token paths can proceed only when every
selected operation supports the derived host.

## Git transport

For an HTTPS remote, Git can use its configured credential helper. After
explicit consent, the official CLI can configure itself as the helper:

```sh
gh auth setup-git --hostname <host>
```

See [`gh auth setup-git`](https://cli.github.com/manual/gh_auth_setup-git).
Do not run or recommend this command for an SSH remote. SSH uses keys and
host-key verification, not the HTTPS credential helper.

## Offline, CI, and headless use

`qube doctor --offline --json` and `aie doctor --offline --json` never spawn
`gh`. Required GitHub checks are `unverified`; non-GitHub checks are
`not-required`. Headless automation should configure the correct environment
token and host, use JSON output, and perform login or account selection outside
the QUBE command. JSON mode does not open a browser, switch accounts, or change
Git credential helpers.

## Status and recovery

| Reason code | Recovery |
| --- | --- |
| `not-required` | No GitHub action is needed for the selected scope or roles. |
| `missing-cli` | Install GitHub CLI from the official instructions. |
| `unsupported-version` | Update GitHub CLI so structured auth status is available. |
| `host-unresolved` | Configure a GitHub origin or explicit host/repository; unsupported App/Enterprise combinations must change publisher or host. |
| `unauthenticated` | Run the host-specific `gh auth login` flow or configure an official environment token. |
| `wrong-account` | Run `gh auth switch --hostname <host> --user <login>` explicitly. |
| `repo-inaccessible` | Verify repository identity and grant the credential repository access. |
| `insufficient-permission` | Grant only the named missing classic, fine-grained, or App permission. |
| `sso-required` | Authorize the credential for the organization's SSO policy. |
| `app-not-installed` | Install or restore the App for the selected repository. |
| `credential-invalid` | Replace or refresh the selected credential source. |
| `network` | Check network, proxy, TLS, and GitHub service availability. |
| `timeout` | Restore connectivity and rerun the bounded probe. |
| `unverified` | Run online or confirm a write permission that cannot be proven read-only. |
| `ready` | No recovery is needed for the listed capability. |

After repair, rerun `qube init` to resume pending provider actions and
`qube doctor --json` to inspect the same safe result. Unchanged local setup is
not rewritten.

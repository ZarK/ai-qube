# BORG Notes

BORG is the system for safely running developer and agent work with bounded authority. It is not primarily an application. It is a set of operating rules, interfaces, and optional packages for isolation, capability grants, policy, approval, and evidence.

QUBE organizes autonomous development work. BORG governs where that work runs and what it is allowed to touch.

## Core Framing

QUBE should remain usable anywhere. A developer may use one QUBE package, compose several QUBE packages, or adopt the full QUBE workflow on a laptop, CI runner, dev container, remote VM, or BORG-managed workspace.

BORG adds another layer:

- isolated execution environments
- brokered credentials and capabilities
- policy-as-code
- trusted approval flows
- audit and revocation
- secret-safe configuration workflows
- agent and tool permission boundaries

The useful product sentence is:

> QUBE decides what work to do. BORG decides what that work is allowed to touch.

## BORG As A System

BORG should not require one blessed runtime, one agent, one forge, or one secrets provider. It should describe a safe operating model that can be implemented with different tools.

System rules:

- No ambient developer credentials in agent or project workspaces.
- Every capability has scope, TTL, audience, and purpose.
- Privileged actions require confirmation outside the compromised workspace.
- Human identity stays on the host, identity provider, hardware key, or trusted approval surface.
- Long-lived secrets are not passed to agents.
- Agents receive schemas, handles, and brokered capabilities, not vault contents.
- Logs record grants and actions but redact values.
- Denial is safe and common.
- Bypass paths are visible.

The goal is not perfect safety. The goal is that a compromised agent or dependency does not automatically become a compromised developer, organization, cloud account, package registry, and production system.

## BORG Roles

BORG can be described as four independent system roles. These may become packages, services, commands, or policies, but each role should also make sense on its own.

### Boundary

Boundary defines where work can run.

Responsibilities:

- disposable workspace lifecycle
- VM, container, devcontainer, remote runner, or local user boundary
- mount policy
- network policy
- workspace TTL
- snapshots and teardown
- prevention of host credential mounts by default

Standalone value: run risky commands, agents, dependency installs, or repo workflows inside a constrained workspace.

QUBE integration: QUBE Executor can ask Boundary for a workspace before executing a work item.

### Oracle Or Orchestrator

Oracle/Orchestrator decides how actions are coordinated without owning all lower-level authority.

Responsibilities:

- single-entry workflow UX
- repo and project detection
- config loading
- routing actions to Boundary, Relay, Guard, and QUBE
- turning high-level intents into bounded work sessions

Standalone value: one coherent developer workflow over existing tools.

QUBE integration: call `aib`, `aie`, `aiq`, and `aiu` as supported workloads without making QUBE depend on BORG.

### Relay

Relay handles capability requests and exchanges. Relay must not become a treasure chest of reusable secrets.

Responsibilities:

- request, approve, mint, revoke, and audit capabilities
- exchange identity for short-lived scoped credentials
- integrate with GitHub Apps, OIDC, Vault, 1Password, cloud IAM, package registries, and Varlock
- avoid storing long-lived secrets wherever possible
- return the smallest usable capability for the current purpose

Standalone value: broker short-lived GitHub, cloud, package, or secret access for any workflow.

QUBE integration: when QUBE needs to open a review item, update a work item, publish, deploy, or read runtime config, it asks Relay for a narrow capability.

Relay is a high-value target. It remains safe only if compromising Relay does not reveal durable secrets or allow unlimited minting. Relay should centralize permission checks, not centralize all authority.

### Guard

Guard evaluates safety policy and records evidence.

Responsibilities:

- policy-as-code validation
- secret exposure checks
- dangerous mount and network detection
- supply-chain risk checks
- audit normalization
- action risk classification
- evidence collection for approvals and later review

Standalone value: check whether a workspace, action, diff, dependency change, or credential request is allowed.

QUBE integration: `aiq` checks quality and truthfulness of work; Guard checks safety of environment, credentials, policy, and authority.

## BORG QUBE

BORG QUBE is the combined operating model for autonomous software work.

Flow:

1. BORG creates or selects an isolated workspace.
2. QUBE selects or plans the next durable work item.
3. Boundary enforces the execution environment.
4. Relay grants only the capabilities needed for the current task.
5. QUBE performs the work through Bootstrap, Executor, Quality-control, and Umpire loops.
6. Guard evaluates policy, risk, and evidence.
7. Review items, work item comments, CI results, and audit records become durable state.
8. Capabilities expire and the workspace is destroyed, archived, or reused under policy.

BORG QUBE should support any capable coding agent, not only one agent product. The point is not to replace tools like Codex, Claude Code, OpenCode, Devin, or Lovable. The point is to provide the control layer in which agentic software work can happen with bounded authority and verifiable evidence.

Positioning:

> Run any coding agent safely, with bounded credentials and verifiable work.

## Scale Models

### Solo Project Developer

A solo developer wants useful safety without ceremony.

Useful defaults:

- one command opens a repo workspace
- no host home directory mount
- no ambient GitHub, SSH, cloud, npm, or password-manager credentials inside the workspace
- Varlock schema is readable by agents, secret values are not
- GitHub access is repo-scoped and short-lived
- dangerous actions ask for host-side confirmation
- logs and grants are easy to inspect

The experience should feel like:

```bash
borg open github.com/user/repo
borg run npm test
borg qube continue
```

The developer should not need to remember a long checklist.

### Multiple Projects For One Developer

A developer with many projects needs separation between projects.

Additional requirements:

- separate workspace identity per repo or task
- separate cache policy per trust level
- no cross-project credential reuse by default
- project-specific network allowlists
- project-specific Varlock schemas and secret providers
- visible grant history per project
- quick workspace destroy/recreate

The failure mode to avoid is one compromised low-trust project gaining access to every other repo, package registry, cloud account, and local credential.

### Remote BORG

BORG can run remotely if it is split into planes:

- control plane: policy, routing, grants, approvals, audit
- execution plane: disposable QUBEs, VMs, containers, or remote runners
- data plane: repo checkouts, artifacts, caches, logs, VFS views
- identity plane: human, agent, repo, and workload identities

The remote VFS must be mediated. It should expose only project-scoped files to each QUBE. It must not expose real home directories, browser cookies, token stores, SSH keys, cloud configs, or password-manager sessions.

A VFS should be:

- project-scoped
- policy-filtered
- read-only where possible
- copy-on-write for workspace mutations
- explicit about artifact export
- audited for sensitive paths
- isolated per QUBE

A remote BORG is not safe if it simply gives agents a shared network filesystem and a broad service token.

### Collective Of BORGs

A collective can coordinate many BORG nodes and many QUBEs across projects.

Each QUBE should have its own:

- workspace identity
- repo scope
- network policy
- mount policy
- credential grants
- TTL
- audit trail
- kill switch

The collective should not share one super-token. Coordination can be centralized, but authority should remain scoped, delegated, and revocable.

Possible uses:

- repo A issue execution
- repo B review cleanup
- dependency upgrade campaign
- docs migration
- security audit
- CI modernization
- package publish dry run

### IT Department And Organization Use

For an IT department, BORG should become the standard work entrypoint rather than optional security tooling.

Organization model:

1. A human, ticket, or automation requests work.
2. BORG creates an isolated QUBE for that work.
3. QUBE runs selected agents and tools.
4. Relay grants only needed access.
5. Guard enforces policy and records evidence.
6. QUBE opens or updates review/work items.
7. CI/CD verifies and deploys through OIDC or workload identity.
8. Audit records show who requested work, what ran, what authority was granted, and what changed.
9. The workspace is destroyed, archived, or retained according to policy.

High-value use cases:

- contractor access
- high-risk repos
- legacy dependency cleanup
- security patching
- internal tool maintenance
- support/debug work with restricted data
- large-scale code modernization
- autonomous agent work under IT governance

The security claim should be modest and defensible: BORG makes unsafe defaults hard, makes safe workflows easy, and limits the blast radius when agents, tools, or dependencies are compromised.

## Threat Model Notes

BORG does not make compromised code harmless. If a workspace legitimately receives a capability, malicious code inside that workspace may try to use it during its lifetime.

BORG reduces impact by making capabilities:

- narrow
- short-lived
- purpose-bound
- audience-bound
- externally approved when privileged
- logged
- revocable

Attacks to expect:

- dependency or IDE extension steals an active token
- malicious tool asks Relay for more authority
- prompt injection tricks an agent into requesting privileged access
- compromised workspace tries to exfiltrate over the network
- attacker targets Relay, policy, approval UI, cache, VFS, or audit paths
- attacker attempts to bypass BORG and use local credentials

Design responses:

- avoid durable secrets in Relay
- enforce network egress policy
- keep approval outside the workspace
- keep audit outside Relay control where possible
- deny broad token minting by policy
- keep host credential paths unavailable
- make bypass visible
- rotate and expire aggressively

## Relationship To Existing Tools

BORG should avoid reinventing core infrastructure where possible.

Prefer integrating with:

- GitHub Apps and fine-grained permissions
- OIDC and workload identity
- Vault dynamic credentials
- 1Password service accounts and SSH agent patterns
- Varlock schemas and runtime secret injection
- existing VM/container/devcontainer systems
- existing CI/CD systems
- existing ticket/review providers through QUBE adapters

BORG is the operating model and glue, not a new OS, password manager, package manager, forge, or CI system.

## Open Source Shape

The project can be MIT open source and still useful for others if the baseline is small and practical.

Early useful artifacts:

- notes and system rules
- policy file examples
- workspace profile examples
- Varlock schema patterns
- Relay capability request schema
- Guard policy/evidence schema
- QUBE integration notes
- reference CLI wrappers only where they prove the model

The first public version should help a solo developer use safer defaults. The same concepts should then scale to multi-project, remote, collective, and IT-managed use without changing the core model.

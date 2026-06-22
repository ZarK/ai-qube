# QUBE Adapter Add-On Policy

QUBE separates product-owned core contracts from optional adapter add-on packages.
Core products own command behavior, local state, and provider-neutral contracts.
Adapters own integration-specific API access, host affordance detection, capability
flags, and unsupported-operation reporting.

## Core Contracts

Core contracts stay in the product packages or shared test infrastructure:

- `@tjalve/qube` owns component discovery, command dispatch, install planning,
  schema exposure, and adapter capability reporting through `qube components`.
- `@tjalve/aib`, `@tjalve/aie`, `@tjalve/aiq`, and `@tjalve/aiu` own their
  package commands, config/state paths, and product-specific side effects.
- Provider-neutral work item, action-plan, path, and command metadata contracts
  stay in shared core libraries.
- Layout detection and fixture corpora stay in core or shared test
  infrastructure unless a heavyweight external system requires a separate
  adapter package.

## Optional Add-Ons

Host, forge, review, work-provider, and CI integrations are optional adapter
packages unless a product package already owns the surface directly.

Adapter packages use the `@tjalve/qube-adapter-<surface>` naming pattern. Each
adapter contract must expose stable package metadata:

- `id`: the integration id, such as `github`, `gitlab`, `linear`, or `opencode`.
- `packageName`: the exact adapter package name.
- `surface`: the owned integration surface.
- `owns`: concrete responsibilities for the adapter.
- `boundary`: a short statement of what stays at the adapter edge.
- `capabilities`: explicit supported, standalone, missing, or unsupported
  capability flags.
- `contractOnly`: whether the package is only a contract declaration.

## Discovery

`qube components --json` exposes the installed component packages and
`adapterCapabilities`. The adapter report distinguishes installed, missing, and
unsupported capabilities:

- Installed adapter capabilities may point to the product command that owns the
  behavior.
- Missing adapter capabilities must include actionable install or setup
  guidance.
- Unsupported capabilities must name the owning surface and next action.

Missing add-ons must never fall back to GitHub semantics, shell guesses, or fake
success. A command that needs a missing adapter must stop with an actionable
error or return an explicit unsupported capability result.

## Layout And Fixtures

Layout detection, repository path classification, and fixture corpora are part of
the core QUBE contract. Keep them in core/shared test infrastructure while they
can run without heavyweight external tooling. If a layout or corpus feature
requires a real external service, native binary, hosted API, or large generated
dataset, move only that integration-specific behavior behind an optional adapter
with the same capability-reporting rules.

## Supply Chain Intake

Adapter add-ons are dependencies. Adding or upgrading one requires the normal
QUBE supply-chain intake: exact versions, intentional lockfile changes,
lifecycle scripts disabled where supported, package-age gates, identity and
provenance checks, and explicit approval when risk cannot be verified.

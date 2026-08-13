# QUBE Linear Provider Support

QUBE treats Linear as a work provider, not as GitHub with different names.
Linear issues, teams, workflow states, labels, projects, comments, and review
artifact links have their own provider contract. GitHub pull requests and CI
checks remain separate review and CI providers unless a repository config
explicitly chooses otherwise.

## Capability Model

Supported now:

- AIB renders provider-neutral work item drafts into Linear issue previews
  through `@tjalve/qube-adapter-linear` with
  `qube aib work-items render --provider linear --dry-run --json`.
- AIE resolves Linear through the optional `@tjalve/qube-adapter-linear`
  work-provider package boundary. The adapter maps Linear issues into QUBE work
  items for read flows.
- Linear workflow state, priority, labels, assignee, project, blockers, and
  source metadata are normalized into the shared work item contract.
- QUBE install notes can target `--work-provider linear` and name the required
  optional adapter package.

Explicitly unsupported now:

- AIB does not create Linear issues. Use `--dry-run` to review planned Linear
  issue payloads.
- AIE does not mutate Linear workflow states, comments, assignees, or close
  Linear issues yet.
- AIE does not silently fall back to GitHub labels when Linear lifecycle
  mutation is requested.
- GitHub pull requests, GitHub Actions, and reviewer gates are still GitHub
  provider behavior, not Linear behavior.

## Configuration

Linear read flows require explicit credentials and scope:

```bash
LINEAR_API_KEY=<personal-api-key>
LINEAR_TEAM_ID=<linear-team-id>
```

The Executor config can select Linear as the work provider:

```json
{
  "version": 1,
  "providers": {
    "work": { "kind": "linear" },
    "review": { "kind": "github" },
    "repository": { "kind": "local-git" },
    "ci": { "kind": "github" },
    "layout": { "kind": "local" },
    "capabilities": {
      "work": true,
      "review": true,
      "repository": true,
      "ci": true,
      "layout": true
    }
  }
}
```

Keep `LINEAR_API_KEY` out of repository files. The adapter reads the documented
environment variable at runtime and fails with an actionable message when it is
missing.

## Work Item Mapping

Linear issue fields map to QUBE work items as follows:

| Linear field | QUBE field |
| --- | --- |
| `identifier` such as `ENG-123` | `displayId` and work item key |
| workflow state type `started` | `in-progress` |
| workflow state type `triage`, `backlog`, or `unstarted` | `ready` |
| workflow state type `completed` or `canceled` | closed work item |
| priority `1`, `2`, `3`, `4` | critical, high, medium, low |
| labels | provider tags |
| assignee | assignees |
| project | project context |
| `Blocked by: ENG-123` in description | Linear blocker key |

Linear metadata is stored under `trustedMetadata.linear*` fields. GitHub issue
numbers are not invented for Linear work items.

## AIB Rendering

Preview Linear issues from recorded provider-neutral drafts:

```bash
qube aib work-items render --provider linear --dry-run --json
```

The JSON output includes `plannedLinearIssues`. Each item contains a Linear
title, description, priority number, label names, optional team key, optional
URL, and native Linear blocker identifiers.

Provider mutation is intentionally blocked:

```bash
qube aib work-items render --provider linear --json
```

The command exits with `provider-mutation-unsupported` until Linear issue
creation has a tested mutation adapter.

## AIE Read Flow

With `providers.work.kind` set to `linear` and the documented environment
variables present, AIE can read Linear issues through the provider contract.
Lifecycle mutation commands report unsupported operations when they would need
to change Linear workflow state, comments, assignees, or completion state.

This is deliberate: Linear workflow states are team-specific, and QUBE must not
guess which state means started, blocked, ready, or done for a team.

## Live Suite Bootstrap

Use this checklist once for a disposable live-suite team. The suite skips
without `QUBE_TESTKIT_LIVE=1` and the credentials below. It never reports
`passed` when it skips.

1. Select a Linear workspace and team that may hold disposable `qube-testkit`
   labels and issues.
2. Create a Linear personal API key. Set `LINEAR_API_KEY` and `LINEAR_TEAM_ID`.
3. Grant the key permission to create labels, create issues, create blocked-by
   relations, and archive issues.
4. Set `QUBE_TESTKIT_LIVE=1`. Run `qube doctor --json`. Then run the Linear
   adapter live suite.

## Known Differences From GitHub

- Linear has teams and team-specific workflow states instead of repository-wide
  issue labels.
- Linear issue identifiers such as `ENG-123` are not numeric GitHub issue
  numbers.
- Linear projects are not GitHub milestones.
- Code review artifacts are links from work, not native pull requests.
- CI status normally comes from the repository provider, not Linear.

# QUBE GitLab Provider Support

QUBE treats GitLab as a work provider with GitLab-native issue and merge
request language. GitLab issues, issue links, merge requests, approvals, branch
pipelines, and self-managed base URLs have their own provider contract. GitHub
pull requests and GitHub Actions remain separate provider behavior unless a
repository config explicitly chooses otherwise.

## Capability Model

Supported now:

- AIB renders provider-neutral work item drafts into GitLab issue previews
  through `@tjalve/qube-adapter-gitlab` with
  `qube aib work-items render --provider gitlab --dry-run --json`.
- AIE resolves GitLab through the optional `@tjalve/qube-adapter-gitlab`
  work-provider package boundary. The adapter maps GitLab project issues into
  QUBE work items for read flows.
- GitLab issue `iid`, state, labels, assignees, milestones, task-completion
  status, native issue links, and source metadata are normalized into the
  shared work item contract.
- AIE reads GitLab merge request review state through the same optional adapter
  when `providers.review.kind` is `gitlab`.
- GitLab merge request notes can carry configured review requests and local
  lane review feedback with stable QUBE metadata.
- GitLab merge request discussions are read as code conversation feedback and
  unresolved discussions are exposed as merge blockers.
- GitLab merge request `head_pipeline` status is exposed as provider gate
  evidence and concise CI diagnostics for `aie pr view` and `aie pr gate`.
- QUBE install notes can target `--work-provider gitlab` and name the required
  optional adapter package.

Explicitly unsupported now:

- AIB does not create GitLab issues. Use `--dry-run` to review planned GitLab
  issue payloads.
- AIE does not mutate GitLab issue states, labels, comments, assignees, or
  completion state yet.
- AIE does not create, update, approve, merge, or close GitLab merge requests.
- AIE does not resolve GitLab merge request discussions yet.
- AIE does not trigger or rerun GitLab pipelines yet.
- AIE does not silently fall back to GitHub labels, pull requests, or Actions
  when GitLab lifecycle, review, or CI behavior is requested.

## Configuration

GitLab read flows require explicit credentials and project scope:

```bash
GITLAB_TOKEN=<personal-or-project-access-token>
GITLAB_PROJECT_ID=<numeric-project-id-or-url-encoded-project-path>
GITLAB_BASE_URL=https://gitlab.com
```

`GITLAB_BASE_URL` is optional and defaults to GitLab.com. Set it for
self-managed GitLab instances.

The Executor config can select GitLab as both the work provider and the review
provider:

```json
{
  "version": 1,
  "providers": {
    "work": { "kind": "gitlab" },
    "review": { "kind": "gitlab" },
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

Keep `GITLAB_TOKEN` out of repository files. The adapter reads the documented
environment variable at runtime and fails with an actionable message when it is
missing.

Issue list reads follow GitLab pagination until all open issues are loaded or a
configured provider `limit` is reached. Native issue links are fetched with one
additional GitLab REST request per issue because GitLab does not expose a bulk
issue-links endpoint; set `includeIssueLinks: false` in provider options when a
read flow does not need native link relationships.

## Work Item Mapping

GitLab issue fields map to QUBE work items as follows:

| GitLab field | QUBE field |
| --- | --- |
| issue `iid` and reference such as `#42` | work item key and `displayId` |
| issue state `opened` | open work item |
| issue state `closed` | closed work item |
| labels `S-InProgress`, `S-Ready`, `S-Blocked` | in-progress, ready, blocked |
| labels `P1-Critical`, `P2-High`, `P3-Medium`, `P4-Low` | critical, high, medium, low |
| labels | provider tags |
| assignees | assignees |
| milestone | project context |
| `task_completion_status` | checklist totals |
| issue links `blocks` and `is_blocked_by` | blocker and blocked-by keys |
| `Blocked by: #42` in description | GitLab blocker key |

GitLab metadata is stored under `trustedMetadata.gitlab*` fields. GitHub issue
numbers are not invented for GitLab work items.

## AIB Rendering

Preview GitLab issues from recorded provider-neutral drafts:

```bash
qube aib work-items render --provider gitlab --dry-run --json
```

The JSON output includes `plannedGitLabIssues`. Each item contains a GitLab
title, description, labels, native numeric blockers, optional milestone, and
optional URL.

Provider mutation is intentionally blocked:

```bash
qube aib work-items render --provider gitlab --json
```

The command exits with `provider-mutation-unsupported` until GitLab issue
creation has a tested mutation adapter.

## AIE Read Flow

With `providers.work.kind` set to `gitlab` and the documented environment
variables present, AIE can read GitLab issues through the provider contract.
Lifecycle mutation commands report unsupported operations when they would need
to change GitLab issue state, labels, comments, assignees, or completion state.

## AIE Merge Request Review Flow

With `providers.review.kind` set to `gitlab` and the documented environment
variables present, AIE can read GitLab merge requests through the review-forge
provider contract. `aie pr view <mr> --json` accepts a GitLab merge request
`iid` and returns provider-native mergeability, code conversations, merge
blockers, provider-visible note feedback, and head-pipeline diagnostics.

`aie pr gate <mr>` plans configured review participants through GitLab merge
request notes. Local review lane publication writes provider-visible GitLab
notes with stable QUBE metadata, and those notes are read back as trusted lane
review records for the current merge request head.

GitLab merge request approval, merge, discussion resolution, and pipeline
triggering are mutation gaps. They remain unsupported until each mutation path
has a tested adapter contract.

## Known Differences From GitHub

- GitLab uses project issue `iid` values and `#iid` references rather than
  GitHub repository issue numbers.
- GitLab issue links can represent `blocks` and `is_blocked_by` relationships.
- GitLab milestones are project metadata, not GitHub milestones.
- GitLab merge requests expose mergeability, reviewers, approval state, and
  pipeline state through GitLab-specific APIs.
- GitLab CI status normally comes from merge request `head_pipeline` or
  project pipeline APIs, not GitHub Checks.

# QUBE Jira Provider Support

QUBE treats Jira as a work provider. Jira issues, projects, workflow states,
priorities, and issue links have their own provider contract. GitHub pull
requests and CI checks stay separate review and CI providers unless a
repository config selects them.

## Capability Model

Supported now:

- AIB renders provider-neutral work item drafts into Jira issue previews
  through `@tjalve/qube-adapter-jira`.
- AIE resolves Jira through the optional `@tjalve/qube-adapter-jira`
  work-provider package. The adapter maps Jira issues into QUBE work items for
  read flows.
- Jira status, priority, labels, components, assignee, project, issue links,
  and source metadata map into the shared work item contract.
- QUBE install notes can target `--work-provider jira` and name the required
  optional adapter package.

Explicitly unsupported now:

- AIB does not create Jira issues.
- AIE does not transition Jira workflow states, add comments, or complete
  Jira issues.
- AIE does not fall back to GitHub labels when a Jira lifecycle mutation is
  requested.

## Configuration

Jira read flows require site credentials:

```bash
JIRA_EMAIL=<atlassian-account-email>
JIRA_API_TOKEN=<atlassian-api-token>
JIRA_BASE_URL=https://example.atlassian.net
JIRA_PROJECT_KEY=ENG
```

`JIRA_BASE_URL` must use `https`. Keep `JIRA_API_TOKEN` out of repository
files.

The Executor config can select Jira as the work provider:

```json
{
  "version": 1,
  "providers": {
    "work": { "kind": "jira" },
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

## Live Suite Bootstrap

Use this checklist once for a disposable live-suite site. The suite skips
without `QUBE_TESTKIT_LIVE=1` and the credentials below. It never reports
`passed` when it skips.

1. Select a Jira Cloud site that may hold disposable software projects named
   `qube-testkit-*`.
2. Create an Atlassian API token for the site account. Set `JIRA_EMAIL`,
   `JIRA_API_TOKEN`, and `JIRA_BASE_URL`.
3. Grant Administer Jira or equivalent permission to create and delete
   projects, create issues, set priority, transition status, and create Blocks
   links.
4. Set `QUBE_TESTKIT_LIVE=1`. Run `qube doctor --json`. Then run the Jira
   adapter live suite.

The provisioner creates a short project key from the run id, seeds the shared
work items, verifies them through the Jira work provider, deletes the project,
and sweeps leftover `qube-testkit-*` projects.

## Work Item Mapping

| Jira field | QUBE field |
| --- | --- |
| issue key such as `ENG-123` | `displayId` and work item key |
| status To Do, Backlog, or Open | `ready` |
| status In Progress | `in-progress` |
| status Blocked | `blocked` |
| priority Highest or Critical | critical |
| priority High | high |
| priority Medium | medium |
| priority Low or Lowest | low |
| labels and components | provider tags |
| Blocks issue links | blocker and blocked-by keys |
| description checklist markers | checklist totals |

## Known Differences From GitHub

- Jira uses project keys and issue keys, not repository issue numbers.
- Jira workflow names are site-specific. Default mapping covers common To Do
  and In Progress names.
- Code review artifacts are not native Jira objects.
- CI status comes from the selected CI provider, not Jira.

# QUBE Jenkins Provider Support

QUBE treats Jenkins as a CI provider. Jenkins jobs, folders, builds, and queue
items have their own provider contract. Work items and review artifacts stay on
the selected work and review providers.

## Capability Model

Supported now:

- AIE reads Jenkins build evidence through the optional
  `@tjalve/qube-adapter-jenkins` package.
- The adapter maps build result, queue state, logs, and artifact URLs into
  provider-neutral gate evidence.
- Missing credentials, missing jobs, queued builds, unstable builds, and
  failed builds are explicit evidence states.
- QUBE install notes can target `--ci-provider jenkins` and name the required
  optional adapter package.

Explicitly unsupported now:

- AIE does not trigger or rerun Jenkins builds.
- AIE does not fall back to GitHub Actions when Jenkins evidence is requested.

## Configuration

Jenkins evidence reads require a controller origin. Set the user and token
together when the controller needs authentication:

```bash
JENKINS_BASE_URL=https://jenkins.example.com
JENKINS_USER=<jenkins-user>
JENKINS_API_TOKEN=<jenkins-api-token>
```

`JENKINS_BASE_URL` must use `https`. Do not put credentials in the URL. Keep
`JENKINS_API_TOKEN` out of repository files.

The Executor config can select Jenkins as the CI provider:

```json
{
  "version": 1,
  "providers": {
    "work": { "kind": "jira" },
    "review": { "kind": "gitlab" },
    "repository": { "kind": "local-git" },
    "ci": { "kind": "jenkins" },
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

Use this checklist once for a disposable live-suite controller. The suite skips
without `QUBE_TESTKIT_LIVE=1` and the credentials below. It never reports
`passed` when it skips.

1. Select a Jenkins controller that may hold disposable folders named
   `qube-testkit-*`. Install the Folders plugin.
2. Create an API token for the Jenkins user. Set `JENKINS_USER`,
   `JENKINS_API_TOKEN`, and `JENKINS_BASE_URL`.
3. Grant Overall/Read, Job/Create, Job/Read, Job/Delete, and folder access so
   the suite can create and delete tagged folders and jobs.
4. Set `QUBE_TESTKIT_LIVE=1`. Run `qube doctor --json`. Then run the Jenkins
   adapter live suite.

The provisioner creates a tagged folder, seeds two disabled jobs, verifies that
the folder and jobs exist, deletes the folder, and sweeps leftover
`qube-testkit-*` root items.

## Known Differences From GitHub Actions

- Jenkins job paths use folder segments, not a GitHub workflow file.
- Jenkins evidence is a build or queue item, not a GitHub check run.
- Trigger and rerun stay unsupported until those mutations have a tested
  adapter contract.

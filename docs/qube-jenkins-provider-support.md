# QUBE Jenkins Provider Support

QUBE treats Jenkins as a CI provider. Jenkins jobs, folders, builds, and queue
items have their own provider contract. Work items and review artifacts stay on
the selected work and review providers.

## Capability Model

Supported now:

- The optional `@tjalve/qube-adapter-jenkins` package reads Jenkins build
  evidence through its adapter API.
- The adapter maps build result, queue state, logs, and artifact URLs into
  provider-neutral gate evidence.
- Missing credentials, missing jobs, queued builds, unstable builds, and
  failed builds are explicit evidence states.

Explicitly unsupported now:

- Executor workflow setup does not accept Jenkins as the CI provider. Use
  GitHub or GitLab CI.
- Executor does not trigger or rerun Jenkins builds.

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

These environment variables configure direct Jenkins adapter reads. They do
not enable Jenkins in Executor workflow setup.

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

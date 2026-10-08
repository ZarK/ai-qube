# Local development

Local mode lets the current agent work directly on your task while you test
the result and give feedback. It applies to any language or kind of project.
Your request supplies the goal, inputs, and constraints.

## Start local work

Run these commands from your project folder:

```sh
qube mode local
qube mode
qube make-it-so "Implement a Python parser for the existing log format"
```

The folder does not need Git, GitHub, or full QUBE initialization.
`make-it-so` returns instructions and your request for the current agent to
follow. It does not launch a separate agent or claim that the work is done.

The agent implements the requested behavior, runs appropriate local checks,
and explains what you can test. It does not select an issue, create a branch,
commit, push, or open a pull request. Umpire allows the agent to stop for your
feedback without resuming the issue queue. Shipping gates remain part of the
shipping workflow; local checks do not claim that those gates passed.

## Reuse the prompt

Use `qube mode --prompt` to display the shared local instructions. You can also
give the agent a request like this:

> Work in local mode on the task below. Implement working behavior using the
> existing project and the materials I provide. Make the supporting changes
> needed to complete the task. Run appropriate local checks, then explain what
> works and how I can test it. Keep the changes focused and preserve unrelated
> work. We are not using the issue, branch, commit, or pull request cycle for
> this work.
>
> Task: [Describe the result, inputs, and constraints.]

The shared instructions do not assume a language, frontend, backend, design
process, or particular kind of input. Add those details only when the task
needs them.

## Mode state and scope

QUBE stores the choice in `.qube/mode.json` and adds a bounded workspace-mode
section to `AGENTS.md`. Existing instructions outside that section remain
unchanged. Provider settings, review settings, source files, and Git state
remain unchanged.

The choice lasts across sessions. Subfolders use the nearest workspace mode.
A nested Git repository or a separate QUBE-initialized workspace forms its own
boundary. User-global setup does not select a development mode for projects.
With no mode file, the default is shipping.

Use `--json` for structured status or `--dry-run` to inspect a mode change
without writing files. Invalid mode state stops workflow dispatch before Git
or provider commands run; correct the reported file before continuing.

## Return to shipping

```sh
qube mode shipping
```

This keeps your edits and restores the normal project workflow. The command
does not start an issue, commit changes, or publish anything. Select the work
to ship explicitly and follow the project's normal checks.

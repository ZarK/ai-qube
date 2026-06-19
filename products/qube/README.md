# @tjalve/qube

QUBE is the composer CLI for the standalone package family:

- `@tjalve/aib` for planning
- `@tjalve/aie` for execution
- `@tjalve/aiq` for quality
- `@tjalve/aiu` for continuation policy

Use direct package commands when you only need one tool. Use `qube` when you
want a single entry point that can list the family and dispatch to the component
versions installed with QUBE.

```sh
qube components
qube run aie -- queue
qube aiq --version
```

`qube` does not hide missing tools. It first resolves component binaries from
QUBE's own install scope, then the local workspace, and only then ambient
`PATH`. PATH fallback emits a diagnostic, and a stale same-package PATH binary is
refused when QUBE can identify its package version.

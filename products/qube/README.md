# @tjalve/qube

QUBE is the composer CLI for the standalone package family:

- `@tjalve/aib` for planning
- `@tjalve/aie` for execution
- `@tjalve/aiq` for quality
- `@tjalve/aiu` for continuation policy

Use direct package commands when you only need one tool. Use `qube` when you
want a single entry point that can list the family and dispatch to an installed
standalone command.

```sh
qube components
qube run aie -- queue
qube aiq --version
```

`qube` does not hide missing tools. If a component command is not installed or
not on `PATH`, it fails with the package to install and the command it expected.

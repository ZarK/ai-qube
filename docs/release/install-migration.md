# QUBE Install And Migration Validation

Supported install modes:

| Mode | Validation expectation |
| --- | --- |
| Fresh QUBE install | Install `@tjalve/qube` with its component dependencies, run `qube components`, and dispatch representative component commands from QUBE's install-scoped `node_modules/.bin`. |
| Upgrade from older standalone packages | If old global `aib`, `aie`, `aiq`, or `aiu` binaries are on `PATH`, `qube run <component>` must prefer the component versions installed with `@tjalve/qube` and refuse a stale same-package PATH binary when it can identify the package version. |
| Local workspace development | Use workspace filters, for example `pnpm --filter @tjalve/qube exec qube components`, only after the package has been built and linked by the workspace install. Do not treat source checkout command tests as installed-package validation. |

Migration guidance:

1. Uninstall or update old globally installed standalone packages before relying on `qube` dispatch.
2. Run `qube components --json` and inspect each component package/version.
3. Run `qube run <component> -- --version --json` for each component that participates in your workflow.
4. If QUBE reports a PATH fallback warning, install the matching component package version or fix the local workspace link.
5. If QUBE refuses a stale PATH binary, remove or update the old global package before retrying.

The composer is version-closed by default: an installed QUBE package depends on the component packages it is expected to dispatch. Ambient PATH lookup is retained only as an explicit fallback with diagnostics.

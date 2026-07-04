# Layout Fixtures

Fixture repositories under this directory model repository shapes for `aie repo inspect` and `aie repo affected`.

Each fixture should be small, deterministic, and free of generated build output. Tests copy or initialize these directories in temporary git repositories before running layout detection, so fixture contents should describe repository structure rather than depend on the active checkout.

Add one positive fixture and one negative or ambiguous fixture for each layout shape issue. Changed-path examples belong in tests so expected affected projects and gates stay executable.

Current fixture shapes:

- `js-workspace`: positive JavaScript workspace fixture with a root package, workspace manifest, app and package projects, Turbo metadata, lockfile, and GitHub Actions workflow.
- `ambiguous-js-workspace`: negative JavaScript workspace fixture with tooling metadata but no root package manifest.
- `python-workspace`: positive Python workspace fixture with a root `pyproject.toml`, uv workspace members, package and service projects, Python workflow metadata, and `uv.lock`.
- `ambiguous-python-workspace`: negative Python workspace fixture with Python workspace tooling metadata and a nested package but no root `pyproject.toml`.
- `single-app-service`: positive single app service fixture with exactly one root package/build signal.
- `ambiguous-single-app`: negative fixture with conflicting root package/build signals that must not be classified as a single app service.

# Layout Fixtures

Fixture repositories under this directory model repository shapes for `aie repo inspect` and `aie repo affected`.

Each fixture should be small, deterministic, and free of generated build output. Tests copy or initialize these directories in temporary git repositories before running layout detection, so fixture contents should describe repository structure rather than depend on the active checkout.

Add one positive fixture and one negative or ambiguous fixture for each layout shape issue. Changed-path examples belong in tests so expected affected projects and gates stay executable.

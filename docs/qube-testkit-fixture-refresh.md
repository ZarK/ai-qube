# Refresh testkit fixtures

Use this workflow when a provider API response changes and an offline fixture no longer matches the live sandbox.

## Before you start

1. Set `QUBE_TESTKIT_LIVE=1`.
2. Set the provider credentials from the provider bootstrap checklist.
3. Keep the working tree clean except for fixture files.

## Refresh one fixture

1. Run the live provisioner suite for that provider.
2. If verify fails because the recorded payload changed, capture the live JSON next to the existing fixture.
3. Run `node scripts/refresh-testkit-fixtures.mjs check <fixture-relative-to-packages/qube-testkit>`, for example `package.json`.
4. Review the digest. If the change is expected, run the same command with `write` to record the digest.
5. Re-run the offline fixture suite. A provider API drift must show as a fixture or digest mismatch, not as a silent production success.

## Safety

The refresh command accepts only a path under `packages/qube-testkit`. Absolute paths, parent-directory segments, and symlink escapes fail.

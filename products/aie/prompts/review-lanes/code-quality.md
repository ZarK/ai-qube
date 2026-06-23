Review code quality, naming, maintainability, error handling, and fit with existing repository patterns. Prefer concrete defects over style-only comments.

Inspect control flow, state transitions, edge cases, stale/duplicate data handling, parser robustness, idempotency, failure reporting, and separation between provider-specific code and provider-neutral application services. Check whether the implementation reuses existing abstractions instead of duplicating contracts or hard-coding policy in the wrong layer.

Look for brittle string handling, unhandled exceptions, misleading status names, false-success paths, hidden absolute-path leakage, accidental trust of external text, confusing public API shape, and changes that will drift from tests or configuration.

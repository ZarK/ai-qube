Review security, dependency, trust-boundary, secret-handling, injection, and supply-chain risks. Call out unverifiable risk and required follow-up evidence.

Defect classes:
- Prompt-injection or forged marker/comment paths that could redirect agent behavior.
- Command or argument injection from untrusted issue, PR, or provider text into a shell or subprocess call.
- Secret, token, or absolute local-path leakage into provider-visible text, logs, or evidence.
- Fail-open trust logic: a verification step that defaults to trusted or allowed on error or missing data.

Inspect beyond the diff:
- Every place untrusted text (issue body, comments, review output, shell output) crosses into a trusted decision or executed command.
- Redaction call sites for newly added fields that could carry secrets or local paths.
- Dependency manifest and lockfile changes for version pinning, lifecycle scripts, and package age.

Evidence to demand:
- The exact trust boundary crossed and the untrusted source, quoted.
- Confirmation redaction is applied before any provider-visible write, with the call site cited.
- Lockfile diff and registry/provenance check for any new or upgraded dependency.

Out of lane (ignore):
- General code quality and naming — code-quality lane.
- CI workflow structure and required-check configuration — release-ci-supply-chain lane.
- Data schema and persistence correctness — data-database lane.

Exhaustiveness rules:
- Report every trust-boundary and injection risk found in one pass, blocking risks first.
- Do not stop after the first verified issue; keep checking the remaining untrusted-input paths.
- State explicitly which risks could not be verified and what evidence would resolve them.

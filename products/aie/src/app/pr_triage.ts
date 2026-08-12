import { createHash } from 'node:crypto';
import type { Config } from '../config/index.js';
import { readCurrentHeadLaneEvidence, readLocalReviewGate, requiredLocalReviewLanes, type LocalReviewLane, type LocalReviewLaneId } from '../local_review_evidence.js';
import { LANE_HEURISTIC_DIGESTS } from '../review_focus.js';
import { ghFailureMessage, runGh, type GhExec } from '../providers/github_adapter_exports.js';
import { createReviewForgeProvider } from '../providers/review_forge_adapters.js';
import { resolveReviewSources } from '../review_source.js';
import { ingestProviderReviewFindings } from '../provider_review_findings.js';
import { redact } from '../redact.js';

const ADVISORY_MARKER_PREFIX = 'qube-advisory';

export interface PrTriageAdvisory {
  lane: string;
  findingId: string | null;
  message: string;
  location: { path: string; line: number | null } | null;
  suggestion: string | null;
  dedupeKey: string;
  disposition: 'planned' | 'created' | 'existing' | 'blocked';
  issueNumber: number | null;
  issueUrl: string | null;
}

export interface PrTriageResult {
  ok: boolean;
  command: 'pr triage';
  pr: number;
  headSha: string;
  dryRun: boolean;
  approvedHead: boolean;
  blockingLanes: string[];
  blockingProviderSources: string[];
  missingRequiredLanes: string[];
  advisories: PrTriageAdvisory[];
  lanesInspected: string[];
  limitation: string | null;
  failures: string[];
  linkComment: 'planned' | 'posted' | 'skipped';
  summary: string;
  nextAction: string;
}

export interface PrTriageOptions {
  prNumber: number;
  repoRoot?: string;
  dryRun?: boolean;
  exec?: GhExec;
}

interface TriagePrContext {
  number: number;
  title: string;
  url: string;
  headSha: string;
  issueNumbers: number[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function triagePrContext(prNumber: number, cwd: string | undefined, exec: GhExec | undefined): Promise<TriagePrContext> {
  const result = await runGh(['pr', 'view', String(prNumber), '--json', 'number,title,url,headRefOid,closingIssuesReferences'], { cwd, exec });
  if (result.exitCode !== 0) throw new Error(ghFailureMessage(`gh pr view ${prNumber}`, result.exitCode, result.stderr || result.stdout));
  const parsed: unknown = JSON.parse(result.stdout);
  if (!isRecord(parsed) || typeof parsed.number !== 'number' || typeof parsed.headRefOid !== 'string' || parsed.headRefOid.trim() === '') {
    throw new Error('gh pr view returned missing or malformed number or headRefOid fields.');
  }
  const issueNumbers = Array.isArray(parsed.closingIssuesReferences)
    ? parsed.closingIssuesReferences.flatMap(entry => isRecord(entry) && typeof entry.number === 'number' && Number.isSafeInteger(entry.number) && entry.number > 0 ? [entry.number] : [])
    : [];
  return {
    number: parsed.number,
    title: typeof parsed.title === 'string' ? parsed.title : `PR #${parsed.number}`,
    url: typeof parsed.url === 'string' ? parsed.url : '',
    headSha: parsed.headRefOid,
    issueNumbers,
  };
}

function advisoryDedupeKey(lane: string, finding: { message: string; location: { path: string; line: number | null } | null; suggestion: string | null }): string {
  const hash = createHash('sha256')
    .update(JSON.stringify({ lane, message: finding.message, path: finding.location?.path ?? null, line: finding.location?.line ?? null, suggestion: finding.suggestion }))
    .digest('hex')
    .slice(0, 16);
  return `${ADVISORY_MARKER_PREFIX}:${hash}`;
}

function advisoryIssueTitle(message: string): string {
  const compact = message.replace(/\s+/g, ' ').trim();
  return `Review advisory: ${compact.length > 70 ? `${compact.slice(0, 67)}...` : compact}`;
}

function advisoryIssueBody(pr: TriagePrContext, advisory: PrTriageAdvisory): string {
  const location = advisory.location ? `${advisory.location.path}${advisory.location.line !== null ? `:${advisory.location.line}` : ''}` : 'not recorded';
  return [
    '## Context',
    '',
    `A review lane raised this advisory finding at an approved head of ${pr.url || `PR #${pr.number}`}. Per ship-ready triage, advisory-only work moves to follow-up issues instead of new commits on an approved head.`,
    '',
    `- Lane: ${advisory.lane}`,
    `- Finding id: ${advisory.findingId ?? 'not recorded'}`,
    `- Location: ${location}`,
    `- Source head: ${pr.headSha}`,
    '',
    '## Finding',
    '',
    advisory.message,
    ...(advisory.suggestion ? ['', '## Suggested direction', '', advisory.suggestion] : []),
    '',
    '## Metadata',
    '',
    `- Dedupe key: \`${advisory.dedupeKey}\``,
  ].join('\n');
}

async function findExistingAdvisoryIssue(dedupeKey: string, cwd: string | undefined, exec: GhExec | undefined): Promise<{ number: number; url: string } | null> {
  const result = await runGh(['issue', 'list', '--state', 'open', '--search', `"${dedupeKey}" in:body`, '--json', 'number,url,body'], { cwd, exec });
  if (result.exitCode !== 0) throw new Error(ghFailureMessage('gh issue list --search', result.exitCode, result.stderr || result.stdout));
  const parsed: unknown = JSON.parse(result.stdout);
  if (!Array.isArray(parsed)) return null;
  for (const entry of parsed) {
    // Provider search is fuzzy; only an exact dedupe-key match in the body counts.
    if (isRecord(entry) && typeof entry.number === 'number' && entry.number > 0 && typeof entry.body === 'string' && entry.body.includes(dedupeKey)) {
      return { number: entry.number, url: typeof entry.url === 'string' ? entry.url : '' };
    }
  }
  return null;
}

function terminalLane(lane: LocalReviewLane | null): lane is LocalReviewLane {
  return lane !== null && (lane.status === 'passed' || lane.status === 'failed' || lane.status === 'needs-work');
}

export async function runPrTriageService(config: Config, options: PrTriageOptions): Promise<PrTriageResult> {
  const dryRun = options.dryRun ?? false;
  const repoRoot = options.repoRoot ?? process.cwd();
  const pr = await triagePrContext(options.prNumber, repoRoot, options.exec);
  // Approved-head verification requires the configured profile's full required
  // lane set to hold passed evidence per linked issue; a single passed lane file
  // must never authorize provider mutation while other required lanes are absent.
  const effectiveProfile = config.reviewProfile === 'remote-compatible' ? 'local-standard' : config.reviewProfile;
  const requiredLaneIds = requiredLocalReviewLanes(effectiveProfile);
  const passedLanesByIssue = new Map<number, Set<LocalReviewLaneId>>();
  // Enumerate every known lane id: triage reads whatever terminal current-head
  // evidence exists, and configured lane subsets simply have no files to read.
  const laneIds = Object.keys(LANE_HEURISTIC_DIGESTS) as LocalReviewLaneId[];
  const advisories: PrTriageAdvisory[] = [];
  const seenKeys = new Set<string>();
  const lanesInspected: string[] = [];
  const blockingLanes: string[] = [];
  let anyEvidence = false;
  for (const issueNumber of pr.issueNumbers) {
    for (const laneId of laneIds) {
      const lane = readCurrentHeadLaneEvidence(repoRoot, issueNumber, pr.number, pr.headSha, laneId);
      if (!terminalLane(lane)) continue;
      anyEvidence = true;
      if (!lanesInspected.includes(laneId)) lanesInspected.push(laneId);
      if (lane.status !== 'passed' || lane.recommendation !== 'approve') {
        if (!blockingLanes.includes(laneId)) blockingLanes.push(laneId);
        continue;
      }
      const passedLanes = passedLanesByIssue.get(issueNumber) ?? new Set<LocalReviewLaneId>();
      passedLanes.add(laneId);
      passedLanesByIssue.set(issueNumber, passedLanes);
      for (const finding of lane.findings.filter(entry => entry.severity === 'advisory')) {
        const location = finding.location && typeof finding.location.path === 'string'
          ? { path: finding.location.path, line: typeof finding.location.line === 'number' ? finding.location.line : null }
          : null;
        const normalized = { message: redact(finding.message), location, suggestion: finding.suggestion ? redact(finding.suggestion) : null };
        const dedupeKey = advisoryDedupeKey(laneId, normalized);
        if (seenKeys.has(dedupeKey)) continue;
        seenKeys.add(dedupeKey);
        advisories.push({
          lane: laneId,
          findingId: finding.id ?? null,
          message: normalized.message,
          location,
          suggestion: normalized.suggestion,
          dedupeKey,
          disposition: 'planned',
          issueNumber: null,
          issueUrl: null,
        });
      }
    }
  }

  // Provider-visible feedback from configured reviewer sources is untrusted task
  // input, distinct from the trusted local lane evidence above: a blocking finding
  // there withholds approval the same way a blocking lane does, and its advisory
  // findings join the same triage batch with source attribution.
  const reviewProvider = await createReviewForgeProvider(config.providers.review.kind, { exec: options.exec, cwd: repoRoot, reviewAgents: config.reviewAgents, publisher: config.providers.review.publisher ?? null, ...config.providers.connections[config.providers.review.kind], ...config.providers.review.connection });
  const reviewSnapshot = await reviewProvider.loadPullRequestReview(pr.number);
  const reviewSources = resolveReviewSources(config);
  const providerFindings = reviewSnapshot.pr.headRefOid === pr.headSha ? ingestProviderReviewFindings(reviewSnapshot.item, reviewSources) : [];
  const blockingProviderSources = [...new Set(providerFindings.filter(finding => finding.severity === 'blocking').map(finding => finding.sourceId))];
  for (const finding of providerFindings.filter(entry => entry.severity === 'advisory')) {
    anyEvidence = true;
    const source = `provider:${finding.sourceId}`;
    if (!lanesInspected.includes(source)) lanesInspected.push(source);
    const normalized = { message: redact(finding.message), location: finding.location, suggestion: null as string | null };
    const dedupeKey = advisoryDedupeKey(source, normalized);
    if (seenKeys.has(dedupeKey)) continue;
    seenKeys.add(dedupeKey);
    advisories.push({
      lane: source,
      findingId: null,
      message: normalized.message,
      location: normalized.location,
      suggestion: null,
      dedupeKey,
      disposition: 'planned',
      issueNumber: null,
      issueUrl: null,
    });
  }

  const limitation = anyEvidence
    ? null
    : 'No terminal current-head local lane evidence or provider-visible reviewer feedback was found. Full local findings, severities, and locations are local-only fields; trusted provider markers carry verdict-level state only, so lane advisories cannot be enumerated from provider metadata beyond configured reviewer sources. Run the PR gate on this machine first.';
  const missingRequiredLanes = pr.issueNumbers.flatMap(issueNumber => requiredLaneIds
    .filter(laneId => !(passedLanesByIssue.get(issueNumber)?.has(laneId) ?? false) && !blockingLanes.includes(laneId))
    .map(laneId => pr.issueNumbers.length > 1 ? `${laneId} (issue #${issueNumber})` : laneId));
  // The gate's evidence evaluation is the authority on whether the head is approved:
  // it enforces required-lane coverage plus the same provenance, prompt-stack, and
  // severity validation that guards the merge itself.
  const localReview = readLocalReviewGate({
    repoRoot,
    issueNumbers: pr.issueNumbers,
    prNumber: pr.number,
    headSha: pr.headSha,
    reviewers: config.localReviewAgents,
    required: true,
    profile: config.reviewProfile,
    severityThreshold: config.reviewSeverityThreshold,
  });
  const approvedHead = anyEvidence && blockingLanes.length === 0 && missingRequiredLanes.length === 0 && localReview.status === 'passed' && blockingProviderSources.length === 0;
  const failures: string[] = [];
  if (!approvedHead) {
    for (const advisory of advisories) advisory.disposition = 'blocked';
  }

  // A non-approved head files nothing, so it also spends no provider search calls
  // and keeps every advisory disposition at blocked.
  for (const advisory of approvedHead ? advisories : []) {
    const existing = await findExistingAdvisoryIssue(advisory.dedupeKey, repoRoot, options.exec);
    if (existing) {
      advisory.disposition = 'existing';
      advisory.issueNumber = existing.number;
      advisory.issueUrl = existing.url;
      continue;
    }
    if (dryRun || !approvedHead) continue;
    const created = await runGh(['issue', 'create', '--title', advisoryIssueTitle(advisory.message), '--body', advisoryIssueBody(pr, advisory)], { cwd: repoRoot, exec: options.exec });
    const url = created.exitCode === 0 ? created.stdout.trim().split('\n').pop() ?? '' : '';
    const numberMatch = url.match(/\/issues\/(\d+)/);
    if (created.exitCode !== 0 || !numberMatch) {
      // Keep the remaining advisories moving and report the partial state instead of
      // abandoning the run after earlier issues were already filed.
      advisory.disposition = 'blocked';
      failures.push(`${advisory.lane} (${advisory.dedupeKey}): ${created.exitCode !== 0 ? ghFailureMessage('gh issue create', created.exitCode, created.stderr || created.stdout) : `gh issue create returned no parsable issue URL (${url || 'empty output'}).`}`);
      continue;
    }
    advisory.disposition = 'created';
    advisory.issueUrl = url;
    advisory.issueNumber = Number(numberMatch[1]);
  }

  let linkComment: PrTriageResult['linkComment'] = 'skipped';
  const createdAdvisories = advisories.filter(advisory => advisory.disposition === 'created');
  const existingAdvisories = advisories.filter(advisory => advisory.disposition === 'existing');
  const plannedAdvisories = advisories.filter(advisory => advisory.disposition === 'planned');
  if (dryRun && approvedHead && plannedAdvisories.length > 0) {
    linkComment = 'planned';
  } else if (createdAdvisories.length > 0) {
    // Only newly filed advisories warrant a link comment; existing-only reruns stay
    // silent, and the comment reports exactly what happened per disposition.
    const headerParts = [
      `filed ${createdAdvisories.length} follow-up issue(s)`,
      ...(existingAdvisories.length > 0 ? [`${existingAdvisories.length} already tracked`] : []),
      ...(advisories.some(advisory => advisory.disposition === 'blocked') ? [`${advisories.filter(advisory => advisory.disposition === 'blocked').length} still pending after failed provider calls`] : []),
    ];
    const lines = [
      `Advisory triage for head ${pr.headSha}: ${headerParts.join(', ')}; advisory-only work moves to follow-up issues instead of new commits on the approved head.`,
      ...advisories.map(advisory => {
        const state = advisory.disposition === 'created'
          ? `filed ${advisory.issueUrl || `#${advisory.issueNumber ?? '?'}`}`
          : advisory.disposition === 'existing'
            ? `already tracked as ${advisory.issueUrl || `#${advisory.issueNumber ?? '?'}`}`
            : 'pending (provider call failed)';
        return `- ${advisory.lane}: ${state} — ${advisory.message.slice(0, 120)}`;
      }),
    ];
    const comment = await runGh(['pr', 'comment', String(pr.number), '--body', lines.join('\n')], { cwd: repoRoot, exec: options.exec });
    if (comment.exitCode !== 0) {
      failures.push(`link comment: ${ghFailureMessage('gh pr comment', comment.exitCode, comment.stderr || comment.stdout)}`);
    } else {
      linkComment = 'posted';
    }
  }

  const created = createdAdvisories.length;
  const existing = existingAdvisories.length;
  const planned = plannedAdvisories.length;
  const summaryParts = [
    `${advisories.length} advisory finding(s) at head ${pr.headSha.slice(0, 12)} across ${lanesInspected.length} lane(s).`,
    ...(blockingLanes.length > 0 ? [`Head is not approved: ${blockingLanes.join(', ')} recorded blocking verdicts, so no follow-up issues were filed.`] : []),
    ...(blockingLanes.length === 0 && anyEvidence && missingRequiredLanes.length > 0 ? [`Head is not approved: required lane coverage is incomplete (${missingRequiredLanes.join(', ')}), so no follow-up issues were filed.`] : []),
    ...(blockingLanes.length === 0 && missingRequiredLanes.length === 0 && anyEvidence && localReview.status !== 'passed' ? [`Head is not approved: local review evidence did not validate (gate status ${localReview.status}), so no follow-up issues were filed.`] : []),
    ...(blockingProviderSources.length > 0 ? [`Head is not approved: provider-visible review source(s) ${blockingProviderSources.join(', ')} recorded blocking findings, so no follow-up issues were filed.`] : []),
    ...(created > 0 ? [`Filed ${created} follow-up issue(s).`] : []),
    ...(existing > 0 ? [`${existing} already tracked.`] : []),
    ...(dryRun && approvedHead && planned > 0 ? [`${planned} would be filed.`] : []),
    ...(failures.length > 0 ? [`${failures.length} provider call(s) failed; rerun to complete the remaining filings.`] : []),
    ...(limitation ? [limitation] : []),
  ];
  return {
    ok: failures.length === 0,
    command: 'pr triage',
    pr: pr.number,
    headSha: redact(pr.headSha),
    dryRun,
    approvedHead,
    blockingLanes,
    blockingProviderSources,
    missingRequiredLanes,
    advisories,
    lanesInspected,
    limitation,
    failures,
    linkComment,
    summary: summaryParts.join(' '),
    nextAction: limitation
      ? 'Run `aie pr gate <pr>` on this machine to record local lane evidence, then rerun `aie pr triage <pr>`.'
      : !approvedHead
        ? blockingLanes.length > 0
          ? 'The current head carries blocking lane verdicts; resolve them through the PR gate before triaging advisories.'
          : missingRequiredLanes.length > 0
            ? 'Required lane coverage is incomplete at the current head; run `aie pr gate <pr>` to completion before triaging advisories.'
            : localReview.status !== 'passed'
              ? `Local review evidence did not validate (gate status ${localReview.status}); rerun `+'`aie pr gate <pr>`'+` to restore trusted current-head evidence before triaging advisories.`
              : 'The current head carries blocking provider-visible review findings; resolve them before triaging advisories.'
        : advisories.length === 0
          ? 'No residual advisories; merge when the PR gate reports ship-ready.'
          : failures.length > 0
            ? 'Some provider calls failed; rerun `aie pr triage <pr>` to complete the remaining filings.'
            : dryRun
              ? 'Rerun without --dry-run to file the planned follow-up issues and link them on the pull request.'
              : 'Follow-up issues are linked on the pull request; merge when the PR gate reports ship-ready.',
  };
}

export function formatPrTriage(result: PrTriageResult): string {
  const lines = [`PR advisory triage for #${result.pr}${result.dryRun ? ' (dry-run)' : ''}: ${result.summary}`];
  if (!result.approvedHead && result.blockingLanes.length > 0) lines.push(`Blocking lane verdicts at this head: ${result.blockingLanes.join(', ')}.`);
  if (!result.approvedHead && result.blockingProviderSources.length > 0) lines.push(`Blocking provider-visible review source(s) at this head: ${result.blockingProviderSources.join(', ')}.`);
  for (const advisory of result.advisories) {
    const location = advisory.location ? ` (${advisory.location.path}${advisory.location.line !== null ? `:${advisory.location.line}` : ''})` : '';
    lines.push(`- [${advisory.disposition}] ${advisory.lane}${location}: ${advisory.message.slice(0, 140)}${advisory.issueUrl ? ` -> ${advisory.issueUrl}` : ''}`);
  }
  lines.push(`Link comment: ${result.linkComment}.`);
  lines.push(`Next action: ${result.nextAction}`);
  return lines.join('\n');
}

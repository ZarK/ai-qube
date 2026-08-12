import { createHash } from 'node:crypto';
import type { Config } from '../config/index.js';
import { readCurrentHeadLaneEvidence, readLocalReviewGate, requiredLocalReviewLanes, type LocalReviewLane, type LocalReviewLaneId } from '../local_review_evidence.js';
import { LANE_HEURISTIC_DIGESTS } from '../review_focus.js';
import { ghFailureMessage, runGh, type GhExec } from '../providers/github_adapter_exports.js';
import { createReviewForgeProvider } from '../providers/review_forge_adapters.js';
import { resolveReviewSources } from '../review_source.js';
import { ingestProviderReviewFindings } from '../provider_review_findings.js';
import { redact } from '../redact.js';

export interface PrTriageAdvisory {
  lane: string;
  findingId: string | null;
  message: string;
  location: { path: string; line: number | null } | null;
  suggestion: string | null;
  dedupeKey: string;
  disposition: 'reported' | 'blocked';
}

export interface PrTriageResult {
  ok: boolean;
  command: 'pr triage';
  pr: number;
  headSha: string;
  approvedHead: boolean;
  blockingLanes: string[];
  blockingProviderSources: string[];
  missingRequiredLanes: string[];
  advisories: PrTriageAdvisory[];
  lanesInspected: string[];
  limitation: string | null;
  summary: string;
  nextAction: string;
}

export interface PrTriageOptions {
  prNumber: number;
  repoRoot?: string;
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
  return `qube-advisory:${hash}`;
}

function terminalLane(lane: LocalReviewLane | null): lane is LocalReviewLane {
  return lane !== null && (lane.status === 'passed' || lane.status === 'failed' || lane.status === 'needs-work');
}

export async function runPrTriageService(config: Config, options: PrTriageOptions): Promise<PrTriageResult> {
  const repoRoot = options.repoRoot ?? process.cwd();
  const pr = await triagePrContext(options.prNumber, repoRoot, options.exec);
  // Approved-head verification requires the configured profile's full required
  // lane set to hold passed evidence per linked issue; a single passed lane file
  // must never authorize a triage report while other required lanes are absent.
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
          disposition: 'reported',
        });
      }
    }
  }

  // Provider-visible feedback from configured reviewer sources is untrusted task
  // input, distinct from the trusted local lane evidence above: a blocking finding
  // there withholds approval the same way a blocking lane does, and its advisory
  // findings join the same triage report with source attribution.
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
      disposition: 'reported',
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
  if (!approvedHead) {
    for (const advisory of advisories) advisory.disposition = 'blocked';
  }

  const summaryParts = [
    `${advisories.length} advisory finding(s) at head ${pr.headSha.slice(0, 12)} across ${lanesInspected.length} lane(s).`,
    ...(blockingLanes.length > 0 ? [`Head is not approved: ${blockingLanes.join(', ')} recorded blocking verdicts, so no advisory disposition is reported.`] : []),
    ...(blockingLanes.length === 0 && anyEvidence && missingRequiredLanes.length > 0 ? [`Head is not approved: required lane coverage is incomplete (${missingRequiredLanes.join(', ')}), so no advisory disposition is reported.`] : []),
    ...(blockingLanes.length === 0 && missingRequiredLanes.length === 0 && anyEvidence && localReview.status !== 'passed' ? [`Head is not approved: local review evidence did not validate (gate status ${localReview.status}), so no advisory disposition is reported.`] : []),
    ...(blockingProviderSources.length > 0 ? [`Head is not approved: provider-visible review source(s) ${blockingProviderSources.join(', ')} recorded blocking findings, so no advisory disposition is reported.`] : []),
    ...(limitation ? [limitation] : []),
  ];
  return {
    ok: true,
    command: 'pr triage',
    pr: pr.number,
    headSha: redact(pr.headSha),
    approvedHead,
    blockingLanes,
    blockingProviderSources,
    missingRequiredLanes,
    advisories,
    lanesInspected,
    limitation,
    summary: summaryParts.join(' '),
    nextAction: limitation
      ? 'Run `aie pr gate <pr>` on this machine to record local lane evidence, then rerun `aie pr triage <pr>`.'
      : !approvedHead
        ? blockingLanes.length > 0
          ? 'The current head carries blocking lane verdicts; resolve them through the PR gate before this report is meaningful.'
          : missingRequiredLanes.length > 0
            ? 'Required lane coverage is incomplete at the current head; run `aie pr gate <pr>` to completion first.'
            : localReview.status !== 'passed'
              ? `Local review evidence did not validate (gate status ${localReview.status}); rerun `+'`aie pr gate <pr>`'+` to restore trusted current-head evidence first.`
              : 'The current head carries blocking provider-visible review findings; resolve them first.'
        : advisories.length === 0
          ? 'No residual advisories; merge when the PR gate reports ship-ready.'
          : 'Fix cheap advisories in this pull request now, or explicitly drop them; fold any advisory that duplicates already-queued Ready work into that existing issue. Never open a new issue for a residual advisory. Merge when the PR gate reports ship-ready.',
  };
}

export function formatPrTriage(result: PrTriageResult): string {
  const lines = [`PR advisory triage for #${result.pr}: ${result.summary}`];
  if (!result.approvedHead && result.blockingLanes.length > 0) lines.push(`Blocking lane verdicts at this head: ${result.blockingLanes.join(', ')}.`);
  if (!result.approvedHead && result.blockingProviderSources.length > 0) lines.push(`Blocking provider-visible review source(s) at this head: ${result.blockingProviderSources.join(', ')}.`);
  for (const advisory of result.advisories) {
    const location = advisory.location ? ` (${advisory.location.path}${advisory.location.line !== null ? `:${advisory.location.line}` : ''})` : '';
    lines.push(`- [${advisory.disposition}] ${advisory.lane}${location}: ${advisory.message.slice(0, 140)}`);
  }
  lines.push(`Next action: ${result.nextAction}`);
  return lines.join('\n');
}

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { RepoAffectedResult } from '@tjalve/qube-core';
import { redact } from '../redact.js';
import { localReviewEvidenceSha256 } from '../local_review_evidence.js';
import type { IssueChecklistSummary } from './issue_checklist.js';
import { mkdirTrustedStoreSync, writeReviewFileGuarded } from './local_review_runner_support.js';

export const REVIEW_HEAD_DIGEST_KIND = 'review-head-digest';
export const REVIEW_HEAD_DIGEST_BUILDER = 'qube-review-digest';

export type ReviewHeadDigestFreshness = 'current' | 'missing' | 'unavailable';

export interface ReviewHeadDigestSource {
  kind: 'issue-body' | 'issue-checklist' | 'pr-intent' | 'criterion-to-proof' | 'diff-stat' | 'changed-paths' | 'layout' | 'related-tests';
  source: string;
  sha256: string | null;
  freshness: ReviewHeadDigestFreshness;
}

export interface ReviewHeadDigestAcceptance {
  issueNumber: number;
  title: string;
  bodyStatus: ReviewHeadDigestFreshness;
  items: Array<{ index: number; text: string; checked: boolean }>;
  requirementSections: Array<{ heading: string; text: string }>;
}

export interface ReviewHeadDigest {
  version: 1;
  kind: typeof REVIEW_HEAD_DIGEST_KIND;
  builder: typeof REVIEW_HEAD_DIGEST_BUILDER;
  prNumber: number;
  headSha: string;
  issueNumbers: number[];
  sha256: string;
  provenance: {
    recordedAt: string;
    sources: ReviewHeadDigestSource[];
  };
  acceptanceCriteria: ReviewHeadDigestAcceptance[];
  prIntent: {
    title: string;
    summary: string;
    criterionToProof: string | null;
    criterionToProofStatus: ReviewHeadDigestFreshness;
  };
  changedPathMap: {
    files: string[];
    projects: string[];
    suggestedGates: string[];
    generatedOrVendor: string[];
    layoutStatus: ReviewHeadDigestFreshness;
  };
  diffStats: string;
  relatedTests: string[];
}

export interface ReviewHeadDigestInput {
  repoRoot: string;
  prNumber: number;
  headSha: string;
  issueNumbers: readonly number[];
  issueChecklists: readonly IssueChecklistSummary[];
  issueBodies: ReadonlyMap<number, string>;
  prTitle: string;
  prBody: string | undefined;
  changedPaths: readonly string[];
  diffStats: string;
  layout?: RepoAffectedResult;
  recordedAt?: string;
}

const REQUIREMENT_HEADING = /requirement|acceptance|context|goal|scope|criteria/i;
const TEST_PATH = /(^|\/)(?:test|tests|__tests__)\//i;
const TEST_FILE = /\.(?:test|spec)\.[^.]+$/i;
export const RELATED_TEST_PATH_LIMIT = 40;
export const DIGEST_CHANGED_PATH_LIMIT = 80;

function sha256Text(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function bounded(value: string, maxCharacters: number): string {
  const normalized = redact(value).replace(/\s+/g, ' ').trim();
  return normalized.length > maxCharacters ? `${normalized.slice(0, maxCharacters)}...` : normalized;
}

export function criterionProofSection(prBody: string): string | null {
  const match = prBody.match(/(?:^|\n)(##\s+Criterion-to-proof[\s\S]*?)(?=\n##\s|$)/i);
  return match ? match[1].trim() : null;
}

function prSummary(prBody: string): string {
  const summary = prBody.match(/(?:^|\n)##\s+Summary\s*\n([\s\S]*?)(?=\n##\s|$)/i);
  if (summary) return bounded(summary[1], 800);
  const withoutMap = prBody.replace(/(?:^|\n)##\s+Criterion-to-proof[\s\S]*?(?=\n##\s|$)/i, '\n');
  return bounded(withoutMap, 800);
}

export function requirementSectionsFromIssueBody(body: string): Array<{ heading: string; text: string }> {
  const sections: Array<{ heading: string; text: string }> = [];
  const parts = body.split(/(?:^|\n)##\s+/);
  for (const part of parts.slice(1)) {
    const newline = part.indexOf('\n');
    const heading = (newline === -1 ? part : part.slice(0, newline)).trim();
    const text = newline === -1 ? '' : part.slice(newline + 1);
    if (heading === '' || !REQUIREMENT_HEADING.test(heading)) continue;
    sections.push({ heading: bounded(heading, 120), text: bounded(text, 800) });
  }
  return sections;
}

export function isReviewTestPath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/');
  return TEST_PATH.test(normalized) || TEST_FILE.test(normalized);
}

export function siblingTestCandidates(path: string): string[] {
  const normalized = path.replace(/\\/g, '/');
  if (isReviewTestPath(normalized)) return [];
  const match = normalized.match(/^(.*)\.([^.]+)$/);
  if (!match) return [];
  return [`${match[1]}.test.${match[2]}`, `${match[1]}.spec.${match[2]}`];
}

export function relatedTestPaths(repoRoot: string, changedPaths: readonly string[]): string[] {
  const related = new Set<string>();
  for (const path of changedPaths) {
    if (related.size >= RELATED_TEST_PATH_LIMIT) break;
    const normalized = path.replace(/\\/g, '/');
    if (isReviewTestPath(normalized)) related.add(normalized);
    if (related.size >= RELATED_TEST_PATH_LIMIT) break;
    for (const candidate of siblingTestCandidates(normalized)) {
      if (related.size >= RELATED_TEST_PATH_LIMIT) break;
      if (existsSync(join(repoRoot, candidate))) related.add(candidate);
    }
  }
  return [...related].slice(0, RELATED_TEST_PATH_LIMIT);
}

function safeSegment(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
}

export function reviewHeadDigestPath(repoRoot: string, issueNumber: number, prNumber: number, headSha: string): string {
  return join(repoRoot, '.qube', 'aie', 'reviews', String(issueNumber), String(prNumber), safeSegment(headSha), 'context-digest.json');
}

function sourceHash(value: string, freshness: ReviewHeadDigestFreshness): string | null {
  return freshness === 'current' ? sha256Text(value) : null;
}

export function buildReviewHeadDigest(input: ReviewHeadDigestInput): ReviewHeadDigest {
  const issueNumbers = [...new Set(input.issueNumbers)];
  const acceptanceCriteria: ReviewHeadDigestAcceptance[] = input.issueChecklists.length > 0
    ? input.issueChecklists.map(summary => {
      const body = input.issueBodies.get(summary.issue.number);
      const bodyStatus: ReviewHeadDigestFreshness = body === undefined || body.trim() === '' ? 'missing' : 'current';
      return {
        issueNumber: summary.issue.number,
        title: redact(summary.issue.title),
        bodyStatus,
        items: summary.checklist.items.map(item => ({ index: item.index, text: bounded(item.text, 160), checked: item.checked })),
        requirementSections: bodyStatus === 'current' ? requirementSectionsFromIssueBody(body ?? '') : [],
      };
    })
    : issueNumbers.map(issueNumber => {
      const body = input.issueBodies.get(issueNumber);
      const bodyStatus: ReviewHeadDigestFreshness = body === undefined || body.trim() === '' ? 'missing' : 'current';
      return {
        issueNumber,
        title: `#${issueNumber}`,
        bodyStatus,
        items: [],
        requirementSections: bodyStatus === 'current' ? requirementSectionsFromIssueBody(body ?? '') : [],
      };
    });

  let criterionToProof: string | null = null;
  let criterionToProofStatus: ReviewHeadDigestFreshness = 'unavailable';
  if (input.prBody !== undefined) {
    const section = criterionProofSection(input.prBody);
    if (section === null) {
      criterionToProofStatus = 'missing';
    } else {
      criterionToProof = bounded(section, 2000);
      criterionToProofStatus = 'current';
    }
  }

  const files = input.changedPaths.map(path => path.replace(/\\/g, '/')).slice(0, DIGEST_CHANGED_PATH_LIMIT);
  const layoutStatus: ReviewHeadDigestFreshness = input.layout ? 'current' : 'unavailable';
  const changedPathMap = {
    files,
    projects: input.layout?.affectedProjects.map(project => project.project.path || project.project.id) ?? [],
    suggestedGates: input.layout ? [...input.layout.suggestedGates] : [],
    generatedOrVendor: input.layout
      ? [...input.layout.layout.generatedPaths, ...input.layout.layout.vendorPaths]
        .map(signal => signal.path)
        .filter(path => files.some(file => file === path || file.startsWith(`${path.replace(/\/$/, '')}/`)))
      : [],
    layoutStatus,
  };
  const relatedTests = relatedTestPaths(input.repoRoot, files);
  const diffStats = input.diffStats.trim() === '' ? 'unavailable' : bounded(input.diffStats, 4000);

  const sources: ReviewHeadDigestSource[] = [
    ...acceptanceCriteria.map(entry => ({
      kind: 'issue-body' as const,
      source: `#${entry.issueNumber}`,
      sha256: sourceHash(input.issueBodies.get(entry.issueNumber) ?? '', entry.bodyStatus),
      freshness: entry.bodyStatus,
    })),
    ...acceptanceCriteria.map(entry => ({
      kind: 'issue-checklist' as const,
      source: `#${entry.issueNumber}`,
      sha256: sourceHash(JSON.stringify(entry.items), 'current'),
      freshness: 'current' as const,
    })),
    {
      kind: 'pr-intent',
      source: `PR #${input.prNumber}`,
      sha256: sourceHash(input.prBody ?? input.prTitle, input.prBody === undefined ? 'unavailable' : 'current'),
      freshness: input.prBody === undefined ? 'unavailable' : 'current',
    },
    {
      kind: 'criterion-to-proof',
      source: `PR #${input.prNumber}`,
      sha256: sourceHash(criterionToProof ?? '', criterionToProofStatus),
      freshness: criterionToProofStatus,
    },
    {
      kind: 'changed-paths',
      source: 'git diff --name-only',
      sha256: sourceHash(files.join('\n'), files.length > 0 ? 'current' : 'missing'),
      freshness: files.length > 0 ? 'current' : 'missing',
    },
    {
      kind: 'diff-stat',
      source: 'git diff --stat',
      sha256: sourceHash(diffStats, diffStats === 'unavailable' ? 'unavailable' : 'current'),
      freshness: diffStats === 'unavailable' ? 'unavailable' : 'current',
    },
    {
      kind: 'layout',
      source: 'inspectAffected',
      sha256: sourceHash(JSON.stringify(changedPathMap), layoutStatus),
      freshness: layoutStatus,
    },
    {
      kind: 'related-tests',
      source: 'changed-path siblings',
      sha256: sourceHash(relatedTests.join('\n'), relatedTests.length > 0 ? 'current' : 'missing'),
      freshness: relatedTests.length > 0 ? 'current' : 'missing',
    },
  ];

  const hashed = {
    version: 1 as const,
    kind: REVIEW_HEAD_DIGEST_KIND as typeof REVIEW_HEAD_DIGEST_KIND,
    builder: REVIEW_HEAD_DIGEST_BUILDER as typeof REVIEW_HEAD_DIGEST_BUILDER,
    prNumber: input.prNumber,
    headSha: input.headSha,
    issueNumbers,
    acceptanceCriteria,
    prIntent: {
      title: redact(input.prTitle),
      summary: input.prBody === undefined ? '' : prSummary(input.prBody),
      criterionToProof,
      criterionToProofStatus,
    },
    changedPathMap,
    diffStats,
    relatedTests,
    sources,
  };
  const sha256 = localReviewEvidenceSha256(hashed);
  return {
    version: 1,
    kind: REVIEW_HEAD_DIGEST_KIND,
    builder: REVIEW_HEAD_DIGEST_BUILDER,
    prNumber: hashed.prNumber,
    headSha: hashed.headSha,
    issueNumbers: hashed.issueNumbers,
    sha256,
    provenance: {
      recordedAt: input.recordedAt ?? new Date().toISOString(),
      sources,
    },
    acceptanceCriteria: hashed.acceptanceCriteria,
    prIntent: hashed.prIntent,
    changedPathMap: hashed.changedPathMap,
    diffStats: hashed.diffStats,
    relatedTests: hashed.relatedTests,
  };
}

export function writeReviewHeadDigest(repoRoot: string, digest: ReviewHeadDigest, primaryIssueNumber: number): string {
  const path = reviewHeadDigestPath(repoRoot, primaryIssueNumber, digest.prNumber, digest.headSha);
  const containment = { repoRoot, subtree: ['.qube', 'aie', 'reviews'] as const };
  mkdirTrustedStoreSync(dirname(path), containment);
  writeReviewFileGuarded(path, `${JSON.stringify(digest, null, 2)}\n`, containment);
  return path;
}

export function reviewHeadDigestContextLines(digest: ReviewHeadDigest, path: string): string[] {
  const relativePath = path.replace(/\\/g, '/').replace(/^.*?(\.qube\/aie\/reviews\/)/, '$1');
  const acceptance = digest.acceptanceCriteria.map(entry => {
    const items = entry.items.length === 0
      ? 'none'
      : entry.items.map(item => `[${item.checked ? 'x' : ' '}] #${item.index} ${item.text}`).join('; ');
    const sections = entry.requirementSections.length === 0
      ? ''
      : `; sections=${entry.requirementSections.map(section => `${section.heading}: ${section.text}`).join(' | ')}`;
    return `#${entry.issueNumber} ${entry.title} body=${entry.bodyStatus}; items=${items}${sections}`;
  }).join(' | ') || 'none loaded';
  const projects = digest.changedPathMap.projects.join(', ') || 'none';
  const tests = digest.relatedTests.join(', ') || 'none detected';
  const files = digest.changedPathMap.files.length === 0
    ? 'none'
    : digest.changedPathMap.files.slice(0, 60).join(', ') + (digest.changedPathMap.files.length > 60 ? `, ... ${digest.changedPathMap.files.length - 60} more path(s) omitted` : '');
  return [
    'Shared per-head review digest (hash-audited). Consume this digest instead of rereading issue bodies, PR threads, or the full diff.',
    `Digest path: ${relativePath}.`,
    `Digest sha256: ${digest.sha256}.`,
    `Digest builder: ${digest.builder}.`,
    `Digest PR intent: ${digest.prIntent.title}. ${digest.prIntent.summary}`.trim(),
    `Digest criterion-to-proof: ${digest.prIntent.criterionToProofStatus}${digest.prIntent.criterionToProof ? ` — ${digest.prIntent.criterionToProof}` : ''}.`,
    `Digest acceptance criteria: ${acceptance}.`,
    `Digest changed files: ${files}.`,
    `Digest affected projects: ${projects}.`,
    `Digest suggested gates: ${digest.changedPathMap.suggestedGates.join(', ') || 'none'}.`,
    `Digest layout status: ${digest.changedPathMap.layoutStatus}.`,
    `Digest diff stat: ${digest.diffStats}.`,
    `Digest related tests: ${tests}.`,
    'Do not reread raw issue bodies or PR review threads. If a digest field is missing or unavailable, record that named gap.',
  ];
}

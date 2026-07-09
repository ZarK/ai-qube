import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, posix, relative, resolve, win32 } from 'node:path';
import { redact } from '../redact.js';

const reportCandidates = [
  '.qube/aiq/out/aiq.report.json',
  '.aiq/out/aiq.report.json',
] as const;

const reportSearchDirs = [
  '.qube/aiq/out',
  '.aiq/out',
] as const;

/** Hard caps so multi-lane prompt planning cannot explode with large AIQ reports. */
export const AIQ_REVIEW_MAX_FINDINGS = 40;
export const AIQ_REVIEW_MAX_CONTEXT_BYTES = 24_000;

export interface AiqFindingLink {
  kind: 'aiq-finding';
  path: string;
  sha256: string;
}

export interface AiqReviewFinding {
  id: string;
  rule: string;
  severity: 'error' | 'warning' | 'info';
  path: string | null;
  line: number | null;
  column: number | null;
  message: string;
  contentHash: string;
  evidenceLink: AiqFindingLink;
}

export interface AiqReviewFindings {
  reportPath: string;
  reportSha256: string;
  scopedToChangedPaths: boolean;
  totalFindingCount: number;
  omittedFindingCount: number;
  truncatedFindingCount: number;
  findings: AiqReviewFinding[];
}

export interface LoadAiqReviewFindingsOptions {
  /** Explicit trusted report path (absolute or repo-relative). */
  reportPath?: string | null;
  /** Additional candidate paths to try after the explicit path. */
  extraReportPaths?: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function safeText(value: string, maxLength = 1200): string {
  const normalized = redact(value).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized;
}

function normalizeRepoPath(value: string): string | null {
  const normalized = posix.normalize(value.replace(/\\/g, '/').replace(/^\.\//, ''));
  if (normalized === '' || normalized === '.' || normalized === '..' || normalized.startsWith('../') || normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) return null;
  return redact(normalized);
}

function isAnyAbsolute(value: string): boolean {
  return isAbsolute(value) || posix.isAbsolute(value) || win32.isAbsolute(value);
}

function relativeInside(basePath: string, filePath: string): string | null {
  const relativePath = win32.isAbsolute(basePath) && win32.isAbsolute(filePath)
    ? win32.relative(basePath, filePath)
    : posix.isAbsolute(basePath) && posix.isAbsolute(filePath)
      ? posix.relative(basePath, filePath)
      : relative(resolve(basePath), resolve(filePath));
  if (relativePath === '' || relativePath === '..' || relativePath.startsWith(`..\\`) || relativePath.startsWith('../') || isAnyAbsolute(relativePath)) return null;
  return normalizeRepoPath(relativePath);
}

function diagnosticPath(repoRoot: string, reportRoot: string | null, value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const filePath = value.trim();
  if (!isAnyAbsolute(filePath)) return normalizeRepoPath(filePath);
  const currentPath = relativeInside(repoRoot, filePath);
  if (currentPath) return currentPath;
  return reportRoot ? relativeInside(reportRoot, filePath) : null;
}

function reportRoot(value: Record<string, unknown>, repoRoot: string): string | null {
  if (!isRecord(value.plan) || !isRecord(value.plan.input) || typeof value.plan.input.root !== 'string' || value.plan.input.root.trim() === '') return null;
  const root = value.plan.input.root.trim();
  return isAnyAbsolute(root) ? root : resolve(repoRoot, root);
}

function diagnosticRule(stageId: string, diagnostic: Record<string, unknown>): string {
  const source = typeof diagnostic.source === 'string' ? safeText(diagnostic.source, 120) : '';
  const code = typeof diagnostic.code === 'string' ? safeText(diagnostic.code, 120) : '';
  if (source !== '' && code !== '') return `${source}/${code}`;
  return code || source || stageId;
}

function diagnosticLine(diagnostic: Record<string, unknown>): number | null {
  if (!isRecord(diagnostic.range)) return null;
  const line = diagnostic.range.startLine;
  return typeof line === 'number' && Number.isSafeInteger(line) && line > 0 ? line : null;
}

function diagnosticColumn(diagnostic: Record<string, unknown>): number | null {
  if (!isRecord(diagnostic.range)) return null;
  const column = diagnostic.range.startColumn;
  return typeof column === 'number' && Number.isSafeInteger(column) && column > 0 ? column : null;
}

function diagnosticSeverity(value: unknown): AiqReviewFinding['severity'] | null {
  return value === 'error' || value === 'warning' || value === 'info' ? value : null;
}

function parseFinding(repoRoot: string, root: string | null, stageId: string, value: unknown): Omit<AiqReviewFinding, 'id' | 'evidenceLink'> | null {
  if (!isRecord(value) || typeof value.message !== 'string') return null;
  const severity = diagnosticSeverity(value.severity);
  if (severity === null) return null;
  const message = safeText(value.message);
  if (message === '') return null;
  const finding = {
    rule: diagnosticRule(stageId, value),
    severity,
    path: diagnosticPath(repoRoot, root, value.file),
    line: diagnosticLine(value),
    column: diagnosticColumn(value),
    message,
  };
  // Include column (and full range identity) so same-line multi-diagnostic rows stay distinct.
  return { ...finding, contentHash: sha256(JSON.stringify(finding)) };
}

function parseReport(repoRoot: string, reportPath: string, contents: string, changedPaths: readonly string[]): AiqReviewFindings | null {
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    return null;
  }
  if (!isRecord(value) || value.artifactType !== 'report' || value.artifactVersion !== 1 || !Array.isArray(value.stages)) return null;
  const root = reportRoot(value, repoRoot);
  const findingsByHash = new Map<string, Omit<AiqReviewFinding, 'id' | 'evidenceLink'>>();
  for (const stage of value.stages) {
    if (!isRecord(stage) || !Array.isArray(stage.diagnostics)) continue;
    const stageId = typeof stage.stageId === 'string' && stage.stageId.trim() !== '' ? safeText(stage.stageId, 120) : 'unknown-stage';
    for (const diagnostic of stage.diagnostics) {
      const finding = parseFinding(repoRoot, root, stageId, diagnostic);
      if (finding) findingsByHash.set(finding.contentHash, finding);
    }
  }
  const allFindings = [...findingsByHash.values()].sort((first, second) =>
    (first.path ?? '').localeCompare(second.path ?? '')
      || (first.line ?? 0) - (second.line ?? 0)
      || (first.column ?? 0) - (second.column ?? 0)
      || first.rule.localeCompare(second.rule)
      || first.contentHash.localeCompare(second.contentHash));
  const changedPathSet = new Set(changedPaths.map(normalizeRepoPath).filter((path): path is string => path !== null));
  const scoped = changedPathSet.size > 0;
  const selected = scoped ? allFindings.filter(finding => finding.path !== null && changedPathSet.has(finding.path)) : allFindings;
  const relativeReportPath = normalizeRepoPath(relative(repoRoot, reportPath))
    ?? (isAnyAbsolute(reportPath) ? null : normalizeRepoPath(reportPath))
    ?? reportCandidates[0];
  const findings = selected.map(finding => {
    const id = `aiq:${finding.contentHash}`;
    return {
      ...finding,
      id,
      evidenceLink: {
        kind: 'aiq-finding' as const,
        path: `${relativeReportPath}#${id}`,
        sha256: finding.contentHash,
      },
    };
  });
  return {
    reportPath: relativeReportPath,
    reportSha256: sha256(contents),
    scopedToChangedPaths: scoped,
    totalFindingCount: allFindings.length,
    omittedFindingCount: allFindings.length - findings.length,
    truncatedFindingCount: 0,
    findings,
  };
}

function envReportPaths(): string[] {
  const paths: string[] = [];
  for (const key of ['QUBE_AIQ_REPORT_PATH', 'AIQ_REPORT_PATH', 'AIQ_OUT_DIR']) {
    const value = process.env[key];
    if (typeof value !== 'string' || value.trim() === '') continue;
    const trimmed = value.trim();
    if (key === 'AIQ_OUT_DIR') {
      paths.push(join(trimmed, 'aiq.report.json'));
    } else {
      paths.push(trimmed);
    }
  }
  return paths;
}

function discoverReportFiles(repoRoot: string, options: LoadAiqReviewFindingsOptions = {}): string[] {
  const discovered: string[] = [];
  const seen = new Set<string>();
  const push = (candidate: string) => {
    const absolute = isAnyAbsolute(candidate) ? candidate : resolve(repoRoot, candidate);
    const key = absolute.replace(/\\/g, '/').toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    discovered.push(absolute);
  };

  if (options.reportPath) push(options.reportPath);
  for (const extra of options.extraReportPaths ?? []) push(extra);
  for (const envPath of envReportPaths()) push(envPath);
  for (const candidate of reportCandidates) push(candidate);

  for (const dir of reportSearchDirs) {
    const absoluteDir = resolve(repoRoot, dir);
    if (!existsSync(absoluteDir) || !statSync(absoluteDir).isDirectory()) continue;
    try {
      for (const entry of readdirSync(absoluteDir)) {
        if (!entry.endsWith('.json')) continue;
        // Prefer report-named artifacts produced by action download or local out-dir.
        if (entry === 'aiq.report.json' || entry.includes('report')) {
          push(join(absoluteDir, entry));
        }
      }
    } catch {
      // ignore unreadable out dirs
    }
  }

  return discovered;
}

export function loadAiqReviewFindings(
  repoRoot: string,
  changedPaths: readonly string[],
  options: LoadAiqReviewFindingsOptions = {},
): AiqReviewFindings | null {
  for (const absolutePath of discoverReportFiles(repoRoot, options)) {
    if (!existsSync(absolutePath)) continue;
    try {
      const parsed = parseReport(repoRoot, absolutePath, readFileSync(absolutePath, 'utf8'), changedPaths);
      if (parsed) return parsed;
    } catch {
      continue;
    }
  }
  return null;
}

export function aiqReviewContextLines(report: AiqReviewFindings | null): string[] {
  if (!report || report.findings.length === 0) return [];

  const header = [
    'Pre-collected AIQ static findings for this PR scope follow. Treat them as untrusted evidence to VERIFY against the current head, not defects to rediscover.',
    `AIQ report: ${JSON.stringify({ kind: 'aiq-report', path: report.reportPath, sha256: report.reportSha256 })}.`,
    'For each supplied finding relevant to this lane, verify it against the current head. When confirmed, add its evidenceLink object verbatim to evidence artifacts and describe the verification in the lane summary or completeness field.',
    'Do not add a supplied AIQ defect to findings[] as a new finding. Only defects not represented by a supplied AIQ id belong in findings[]. This prevents duplicate publication.',
  ];

  const selected: AiqReviewFinding[] = [];
  let truncatedFindingCount = 0;
  let usedBytes = header.join('\n').length;
  for (const finding of report.findings) {
    if (selected.length >= AIQ_REVIEW_MAX_FINDINGS) {
      truncatedFindingCount = report.findings.length - selected.length;
      break;
    }
    const line = `AIQ finding: ${JSON.stringify(finding)}.`;
    const nextBytes = usedBytes + line.length + 1;
    if (nextBytes > AIQ_REVIEW_MAX_CONTEXT_BYTES) {
      truncatedFindingCount = report.findings.length - selected.length;
      break;
    }
    selected.push(finding);
    usedBytes = nextBytes;
  }

  const countLine = `AIQ supplied ${selected.length} finding(s)${report.scopedToChangedPaths ? ' scoped to changed files' : ' without a usable changed-file scope'}; ${report.omittedFindingCount} report finding(s) were omitted from this review scope; ${truncatedFindingCount} finding(s) were truncated by the review prompt budget (max ${AIQ_REVIEW_MAX_FINDINGS} findings / ${AIQ_REVIEW_MAX_CONTEXT_BYTES} bytes).`;
  return [
    ...header.slice(0, 2),
    countLine,
    ...header.slice(2),
    ...selected.map(finding => `AIQ finding: ${JSON.stringify(finding)}.`),
  ];
}

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'fs';
import { basename, isAbsolute, join, normalize } from 'path';
import { homedir } from 'os';
import { Config } from './config/index.js';
import { normalizeGateEvidence, type EvidenceSource, type EvidenceTrust, type GateEvidence, type GateEvidenceReasonCode, type GateResult } from './core/gate_evidence.js';
import { redact } from './redact.js';
import { evaluateUiAuditRecord, UI_AUDIT_RECORD_NAME, uiAuditRecordTemplate, type UiAuditOutcome, type UiAuditReason, type UiAuditScreenshot, type UiAuditRecord } from './audit_record.js';

export interface UiAuditCheck {
  id: string;
  title: string;
  why: string;
  action: string;
}

export interface UiAuditEvidence {
  directory: string;
  screenshotsDirectory: string;
  notesPath: string;
  browserObservationPath: string;
  directoryExists: boolean;
  recordPath: string;
  recordFound: boolean;
  notesFound: boolean;
  browserObservationFound: boolean;
  screenshotCount: number;
  screenshots: UiAuditScreenshot[];
  outcome: UiAuditOutcome;
  reportedOutcome: 'passed' | 'failed' | 'blocked' | null;
  reasons: UiAuditReason[];
  stale: boolean;
  missing: string[];
  source: EvidenceSource;
  trust: EvidenceTrust;
  reasonCode: GateEvidenceReasonCode;
  summary: string;
  verified: false;
  gateEvidence: GateEvidence;
}

export interface UiAuditResult {
  ok: true;
  command: 'audit ui';
  issue: number;
  required: boolean;
  dryRun: boolean;
  prepare: boolean;
  check: boolean;
  preferredBrowser: 'agent-browser';
  fallbackBrowserAutomation: string;
  uploadEnabled: false;
  appLaunch: string | null;
  auditTarget: string | null;
  evidence: UiAuditEvidence;
  recordTemplate: UiAuditRecord;
  createdDirectories: string[];
  checklist: UiAuditCheck[];
  warnings: string[];
  nextAction: string;
}

export interface UiAuditOptions {
  issueNumber: number;
  repoRoot?: string;
  homeDirectory?: string;
  dryRun?: boolean;
  prepare?: boolean;
  check?: boolean;
  headSha?: string | null;
}

export const DEFAULT_UI_AUDIT_EVIDENCE_ROOT = '~/.qube/verification';

export function uiAuditEvidenceDirectory(
  issueNumber: number,
  repoRoot?: string,
  homeDirectory?: string,
  configuredRoot?: string,
): string {
  const home = homeDirectory ?? homedir();
  const resolved = resolveUiAuditNamespaceRoot(configuredRoot, home);
  if (!resolved.ok) throw new Error(resolved.reason);
  return join(resolved.root, safeSegment(repoRoot ? basename(repoRoot) : 'repository'), String(issueNumber));
}

const CHECKLIST: UiAuditCheck[] = [
  {
    id: 'running-app',
    title: 'Open the real running application',
    why: 'Manual UI audit evidence must come from the application users will actually see, not from generated instructions or static guesses.',
    action: `Start the app with the repository command, navigate to the target page in a real browser, and record the head, URL, browser session, and viewport in ${UI_AUDIT_RECORD_NAME}.`,
  },
  {
    id: 'visible-outcomes',
    title: 'Verify visible outcomes and core interactions',
    why: 'Executor cannot infer pass/fail from screenshots alone; the agent must inspect the rendered behavior and user-facing state changes.',
    action: `Use agent-browser first. Click, type, navigate, visually inspect the result, and record actions, visible outcomes, findings, and blockers in ${UI_AUDIT_RECORD_NAME}.`,
  },
  {
    id: 'accessibility-keyboard',
    title: 'Check keyboard and accessibility basics',
    why: 'Keyboard traps, missing focus indicators, and inaccessible controls can block users even when the layout looks correct.',
    action: 'Tab through the relevant flow, confirm focus visibility/order, check labels and announcements, and note any blocker.',
  },
  {
    id: 'responsive-visual',
    title: 'Inspect responsive and visual quality',
    why: 'UI changes must remain usable across practical viewport sizes and should not introduce obvious clipping, overlap, or unreadable states.',
    action: `Check applicable narrow and desktop widths. Capture and inspect PNG screenshots for important states, keep them in screenshots/, and reference every screenshot with its SHA-256 from ${UI_AUDIT_RECORD_NAME}.`,
  },
];

export function parseAuditIssueNumber(input: string | undefined): number | null {
  if (!input) return null;
  const normalized = input.startsWith('#') ? input.slice(1) : input;
  if (!/^\d+$/.test(normalized)) {
    throw new Error(`issue must be a positive integer such as 93 or #93; received ${input}`);
  }
  const issueNumber = Number(normalized);
  if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) {
    throw new Error(`issue must be a positive integer such as 93 or #93; received ${input}`);
  }
  return issueNumber;
}

function safeSegment(value: string): string {
  const segment = value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return segment === '' ? 'repository' : segment;
}

export function pathHasParentSegment(value: string): boolean {
  return value.split(/[\\/]+/).some(segment => segment === '..');
}

export function expandUserPath(value: string, homeDirectory: string): string {
  const trimmed = value.trim();
  if (trimmed === '~') return homeDirectory;
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) return join(homeDirectory, trimmed.slice(2));
  return trimmed;
}

export function resolveUiAuditNamespaceRoot(
  configuredRoot: string | undefined,
  homeDirectory: string,
): { ok: true; root: string } | { ok: false; reason: string } {
  const raw = (configuredRoot ?? '').trim();
  const source = raw === '' ? DEFAULT_UI_AUDIT_EVIDENCE_ROOT : raw;
  if (pathHasParentSegment(source)) {
    return { ok: false, reason: 'policy.audit.evidenceRoot must not contain parent-directory segments.' };
  }
  const expanded = expandUserPath(source, homeDirectory);
  if (pathHasParentSegment(expanded)) {
    return { ok: false, reason: 'policy.audit.evidenceRoot must not contain parent-directory segments.' };
  }
  const resolved = isAbsolute(expanded) ? normalize(expanded) : normalize(join(homeDirectory, expanded));
  return { ok: true, root: resolved };
}

function hasNonEmptyFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile() && statSync(path).size > 0;
}

function auditSummary(outcome: UiAuditOutcome, reasons: readonly UiAuditReason[], required = true): string {
  if (!required) return 'Manual UI audit is disabled by repository config.';
  if (outcome === 'passed') return 'The structured browser-observed audit reports passed for the current head, and all referenced PNG screenshots validated.';
  if (outcome === 'failed') return 'The structured browser-observed audit records visible findings and reports failed.';
  if (outcome === 'blocked') return 'The structured audit records an exact browser or application blocker.';
  return reasons[0]?.message ?? 'The manual UI audit is incomplete.';
}

function auditReasonCode(outcome: UiAuditOutcome, required: boolean, stale: boolean, recordFound: boolean): GateEvidenceReasonCode {
  if (!required) return 'manual-audit-disabled';
  if (stale) return 'stale-evidence';
  if (outcome === 'passed' || outcome === 'failed' || outcome === 'blocked') return 'local-evidence-found';
  return recordFound ? 'manual-audit-incomplete' : 'missing-evidence';
}

function auditResult(outcome: UiAuditOutcome, stale: boolean): GateResult {
  if (stale) return 'stale';
  if (outcome === 'passed') return 'passed';
  if (outcome === 'failed') return 'failed';
  return 'unknown';
}

function auditTrust(outcome: UiAuditOutcome): EvidenceTrust {
  return outcome === 'incomplete' ? 'unverified' : 'agent-reported';
}

function buildAuditGateEvidence(issueNumber: number, directory: string, evidence: Pick<UiAuditEvidence, 'outcome' | 'reportedOutcome' | 'stale'>, summary: string, trust: EvidenceTrust, reasonCode: GateEvidenceReasonCode): GateEvidence {
  return normalizeGateEvidence({
    key: `manual-ui-audit:${issueNumber}`,
    name: `Manual UI audit for issue #${issueNumber}`,
    stage: 'pre-pr',
    result: auditResult(evidence.outcome, evidence.stale),
    source: 'manual-audit',
    trust,
    command: null,
    providerRunId: null,
    path: redact(directory),
    summary,
    recordedAt: null,
    reasonCode,
    stale: evidence.stale,
    metadata: { issue: issueNumber, outcome: evidence.outcome, reportedOutcome: evidence.reportedOutcome },
  });
}

function withAuditEvidence(issueNumber: number, evidence: Omit<UiAuditEvidence, 'source' | 'trust' | 'reasonCode' | 'summary' | 'verified' | 'gateEvidence'>): UiAuditEvidence {
  const source: EvidenceSource = 'manual-audit';
  const trust = auditTrust(evidence.outcome);
  const reasonCode = auditReasonCode(evidence.outcome, true, evidence.stale, evidence.recordFound);
  const summary = auditSummary(evidence.outcome, evidence.reasons);
  return {
    ...evidence,
    source,
    trust,
    reasonCode,
    summary,
    verified: false,
    gateEvidence: buildAuditGateEvidence(issueNumber, evidence.directory, evidence, summary, trust, reasonCode),
  };
}

function readEvidence(directory: string, issueNumber: number, headSha: string | null): UiAuditEvidence {
  const screenshotsDirectory = join(directory, 'screenshots');
  const notesPath = join(directory, 'notes.md');
  const browserObservationPath = join(directory, 'browser-observation.md');
  const directoryExists = existsSync(directory) && statSync(directory).isDirectory();
  const notesFound = hasNonEmptyFile(notesPath);
  const browserObservationFound = hasNonEmptyFile(browserObservationPath);
  const evaluation = evaluateUiAuditRecord(directory, headSha);
  return withAuditEvidence(issueNumber, {
    directory: redact(directory),
    screenshotsDirectory: redact(screenshotsDirectory),
    notesPath: redact(notesPath),
    browserObservationPath: redact(browserObservationPath),
    directoryExists,
    recordPath: redact(evaluation.recordPath),
    recordFound: existsSync(evaluation.recordPath),
    notesFound,
    browserObservationFound,
    screenshotCount: evaluation.screenshots.length,
    screenshots: evaluation.screenshots,
    outcome: evaluation.outcome,
    reportedOutcome: evaluation.reportedOutcome,
    reasons: evaluation.reasons,
    stale: evaluation.stale,
    missing: evaluation.reasons.map(item => item.message),
  });
}

function disabledEvidence(directory: string, issueNumber: number, headSha: string | null): UiAuditEvidence {
  const evidence = readEvidence(directory, issueNumber, headSha);
  const summary = auditSummary('incomplete', [], false);
  const trust: EvidenceTrust = 'unverified';
  const reasonCode: GateEvidenceReasonCode = 'manual-audit-disabled';
  return {
    ...evidence,
    outcome: 'incomplete',
    reasons: [],
    stale: false,
    missing: [],
    trust,
    reasonCode,
    summary,
    gateEvidence: buildAuditGateEvidence(issueNumber, evidence.directory, { outcome: 'incomplete', reportedOutcome: evidence.reportedOutcome, stale: false }, summary, trust, reasonCode),
  };
}

function resolveAuditHeadSha(repoRoot: string | undefined, explicit: string | null | undefined): string | null {
  if (explicit && explicit.trim() !== '') return explicit.trim();
  if (!repoRoot) return null;
  try {
    const sha = execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    return /^[a-f0-9]{7,40}$/i.test(sha) ? sha.toLowerCase() : null;
  } catch {
    return null;
  }
}

function createDirectory(path: string, dryRun: boolean, created: string[]): void {
  if (existsSync(path)) return;
  if (!dryRun) mkdirSync(path, { recursive: true });
  created.push(redact(path));
}

function buildWarnings(config: Config): string[] {
  const warnings = [
    'Screenshot upload is out of scope and disabled by default; keep evidence local unless a future opt-in integration is configured.',
    `Executor derives the typed audit outcome from ${UI_AUDIT_RECORD_NAME}; screenshots, hashes, browser observations, and local notes alone never produce a pass.`,
  ];
  if (!config.uiAuditAppLaunch || !config.uiAuditTarget) {
    warnings.push('No app launch command or audit target URL is configured yet. Discover a repository start command, start it with `qube aie run start --name ui-audit -- <command>`, wait with `qube aie run wait --name ui-audit --url <url> --timeout 30`, then record them with `qube aie audit ui set-run --command "<command>" --url <url>`.');
  }
  if (!config.manualUiAudit) warnings.unshift('Manual UI audit is disabled by repository config.');
  return warnings;
}

function nextAction(result: Pick<UiAuditResult, 'required' | 'prepare' | 'check' | 'dryRun' | 'evidence' | 'appLaunch' | 'auditTarget'>): string {
  if (!result.required) return 'No manual UI audit is required by config; record why the UI audit does not apply before shipping UI work.';
  if (result.prepare && !result.dryRun) return `Run the real application, navigate and interact with changed flows, visually inspect each applicable state, inspect captured PNG screenshots, and record the browser-observed outcome in ${UI_AUDIT_RECORD_NAME}.`;
  if (result.check) {
    if (result.evidence.outcome === 'passed') return 'The current-head structured audit reports passed. Review the browser-observed states and validated screenshots before shipping.';
    if (result.evidence.outcome === 'failed') return 'Fix the recorded visible findings, rerun the affected browser states, and record a new current-head audit.';
    if (result.evidence.outcome === 'blocked') return 'Resolve the recorded browser or application blocker, then rerun the manual UI audit. Do not ship it as passed.';
    return `Address the focused audit reasons, update ${UI_AUDIT_RECORD_NAME}, and rerun \`aie audit ui <issue> --check\`.`;
  }
  if (result.appLaunch && result.auditTarget) {
    return `Reuse \`qube aie run start --name ui-audit -- ${result.appLaunch}\` and \`qube aie run wait --name ui-audit --url ${result.auditTarget} --timeout 30\`. Pass an explicit start command to override. Then run \`aie audit ui <issue> --prepare\` and inspect the real running app.`;
  }
  return 'Run `aie audit ui <issue> --prepare`, start the app with `qube aie run start --name ui-audit -- <command>`, wait with `qube aie run wait --name ui-audit --url <url> --timeout 30`, record them with `qube aie audit ui set-run --command "<command>" --url <url>`, then inspect the real running app.';
}

export function runUiAudit(config: Config, options: UiAuditOptions): UiAuditResult {
  const dryRun = options.dryRun ?? false;
  const prepare = options.prepare ?? false;
  const check = options.check ?? false;
  const home = options.homeDirectory ?? homedir();
  const directory = uiAuditEvidenceDirectory(options.issueNumber, options.repoRoot, home, config.uiAuditEvidenceRoot);
  const screenshotsDirectory = join(directory, 'screenshots');
  const createdDirectories: string[] = [];
  if (prepare) {
    createDirectory(directory, dryRun, createdDirectories);
    createDirectory(screenshotsDirectory, dryRun, createdDirectories);
  }
  const headSha = resolveAuditHeadSha(options.repoRoot, options.headSha);
  const evidence = config.manualUiAudit ? readEvidence(directory, options.issueNumber, headSha) : disabledEvidence(directory, options.issueNumber, headSha);
  const warnings = buildWarnings(config);
  const result: UiAuditResult = {
    ok: true,
    command: 'audit ui',
    issue: options.issueNumber,
    required: config.manualUiAudit,
    dryRun,
    prepare,
    check,
    preferredBrowser: 'agent-browser',
    fallbackBrowserAutomation: 'Use Playwright or another browser automation tool only when agent-browser is unavailable or insufficient.',
    uploadEnabled: false,
    appLaunch: config.uiAuditAppLaunch === '' ? null : redact(config.uiAuditAppLaunch),
    auditTarget: config.uiAuditTarget === '' ? null : redact(config.uiAuditTarget),
    evidence,
    recordTemplate: uiAuditRecordTemplate(headSha, config.uiAuditTarget === '' ? null : config.uiAuditTarget),
    createdDirectories,
    checklist: CHECKLIST.map(item => ({ ...item })),
    warnings,
    nextAction: '',
  };
  return { ...result, nextAction: nextAction(result) };
}

export function formatUiAudit(result: UiAuditResult): string {
  const lines = [`Manual UI audit for issue #${result.issue}: ${result.required ? 'required' : 'disabled by config'}.`];
  lines.push(`Evidence directory: ${result.evidence.directory}`);
  lines.push(`Browser observation: ${result.evidence.browserObservationPath}`);
  lines.push(`Visual analysis notes: ${result.evidence.notesPath}`);
  lines.push(`Structured audit record: ${result.evidence.recordPath}`);
  lines.push(`Record template: rerun with --json and use recordTemplate as the ${UI_AUDIT_RECORD_NAME} shape; replace every placeholder with browser-observed values.`);
  lines.push(`Screenshots directory: ${result.evidence.screenshotsDirectory}`);
  if (result.prepare) lines.push(result.dryRun ? 'Dry-run: would create local evidence directories if missing.' : 'Prepared local evidence directories if they were missing.');
  if (result.check) lines.push(`Audit outcome: ${result.evidence.outcome}${result.evidence.reportedOutcome ? ` (reported ${result.evidence.reportedOutcome})` : ''}.`);
  lines.push(`Evidence source: ${result.evidence.source}/${result.evidence.trust}; reason=${result.evidence.reasonCode}.`);
  lines.push('Preferred browser: agent-browser.');
  lines.push(`Fallback: ${result.fallbackBrowserAutomation}`);
  lines.push(result.appLaunch
    ? `App launch: ${result.appLaunch}`
    : `App launch: not configured; start the real application with the repository-specific command and record the browser-observed run in ${UI_AUDIT_RECORD_NAME}.`);
  lines.push(result.auditTarget
    ? `Audit target: ${result.auditTarget}`
    : `Audit target: not configured; open the changed UI route in the real running app and record the URL in ${UI_AUDIT_RECORD_NAME}.`);
  lines.push('Checklist:');
  for (const item of result.checklist) {
    lines.push(`- ${item.title}: ${item.action}`);
  }
  if (result.evidence.reasons.length > 0) {
    lines.push('Audit reasons:');
    for (const reason of result.evidence.reasons) lines.push(`- ${reason.code}: ${reason.message}`);
  }
  lines.push('Screenshot upload: disabled and out of scope; keep screenshots local by default.');
  lines.push(`Executor reports the observer's typed audit outcome only after validating ${UI_AUDIT_RECORD_NAME}, current-head binding, and referenced PNG evidence. It never infers visual correctness from files or hashes alone.`);
  lines.push(`Next action: ${result.nextAction}`);
  return lines.join('\n');
}

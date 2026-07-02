import { existsSync, mkdirSync, readdirSync, statSync } from 'fs';
import { basename, join } from 'path';
import { homedir } from 'os';
import { Config } from './config/index.js';
import { normalizeGateEvidence, type EvidenceSource, type EvidenceTrust, type GateEvidence, type GateEvidenceReasonCode, type GateResult } from './core/gate_evidence.js';
import { redact } from '@tjalve/qube-adapter-github';

export type UiAuditEvidenceState =
  | 'disabled'
  | 'missing'
  | 'metadata-only'
  | 'browser-visited'
  | 'screenshots-captured'
  | 'visual-analysis-recorded';

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
  notesFound: boolean;
  browserObservationFound: boolean;
  screenshotCount: number;
  state: UiAuditEvidenceState;
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
}

const SCREENSHOT_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp'];

const CHECKLIST: UiAuditCheck[] = [
  {
    id: 'running-app',
    title: 'Open the real running application',
    why: 'Manual UI audit evidence must come from the application users will actually see, not from generated instructions or static guesses.',
    action: 'Start the app with the repository command, open the target page, and record the URL, commit, browser, and viewport in browser-observation.md.',
  },
  {
    id: 'visible-outcomes',
    title: 'Verify visible outcomes and core interactions',
    why: 'Executor cannot infer pass/fail from screenshots alone; the agent must inspect the rendered behavior and user-facing state changes.',
    action: 'Use agent-browser first. Click, type, navigate, and describe the visible outcome for the changed UI paths in notes.md.',
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
    action: 'Check at narrow, medium, and desktop widths. Capture local screenshots for the important states and keep them in screenshots/.',
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

function evidenceRoot(repoRoot: string | undefined, homeDirectory: string): string {
  const repoName = safeSegment(repoRoot ? basename(repoRoot) : 'repository');
  return join(homeDirectory, 'github-verification', repoName);
}

function hasNonEmptyFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile() && statSync(path).size > 0;
}

function countScreenshots(path: string): number {
  if (!existsSync(path) || !statSync(path).isDirectory()) return 0;
  return readdirSync(path).filter(name => {
    const screenshotPath = join(path, name);
    const lower = name.toLowerCase();
    try {
      return statSync(screenshotPath).isFile() && SCREENSHOT_EXTENSIONS.some(extension => lower.endsWith(extension));
    } catch {
      return false;
    }
  }).length;
}

function auditSummary(state: UiAuditEvidenceState): string {
  if (state === 'disabled') return 'Manual UI audit is disabled by repository config.';
  if (state === 'visual-analysis-recorded') return 'Browser observation, local screenshots, and visual analysis notes were found. Executor reports evidence presence only and cannot certify audit pass/fail.';
  if (state === 'screenshots-captured') return 'Local screenshots were found, but browser observation and/or visual analysis notes are still missing.';
  if (state === 'browser-visited') return 'A browser observation note was found, but screenshots or visual analysis notes are still missing.';
  if (state === 'metadata-only') return 'Manual UI audit evidence directory exists, but browser/screenshot evidence and visual analysis are missing.';
  return 'No manual UI audit evidence is recorded for this issue.';
}

function auditReasonCode(state: UiAuditEvidenceState): GateEvidenceReasonCode {
  if (state === 'disabled') return 'manual-audit-disabled';
  if (state === 'visual-analysis-recorded') return 'local-evidence-found';
  if (state === 'metadata-only' || state === 'browser-visited' || state === 'screenshots-captured') return 'manual-audit-incomplete';
  return 'missing-evidence';
}

function auditResult(state: UiAuditEvidenceState): GateResult {
  if (state === 'missing') return 'missing';
  return 'unknown';
}

function auditTrust(state: UiAuditEvidenceState): EvidenceTrust {
  return state === 'visual-analysis-recorded' ? 'local-evidence' : 'unverified';
}

function buildAuditGateEvidence(issueNumber: number, directory: string, state: UiAuditEvidenceState, summary: string, trust: EvidenceTrust, reasonCode: GateEvidenceReasonCode): GateEvidence {
  return normalizeGateEvidence({
    key: `manual-ui-audit:${issueNumber}`,
    name: `Manual UI audit for issue #${issueNumber}`,
    stage: 'pre-pr',
    result: auditResult(state),
    source: 'manual-audit',
    trust,
    command: null,
    providerRunId: null,
    path: redact(directory),
    summary,
    recordedAt: null,
    reasonCode,
    stale: false,
    metadata: { issue: issueNumber, state },
  });
}

function withAuditEvidence(issueNumber: number, evidence: Omit<UiAuditEvidence, 'source' | 'trust' | 'reasonCode' | 'summary' | 'verified' | 'gateEvidence'>): UiAuditEvidence {
  const source: EvidenceSource = 'manual-audit';
  const trust = auditTrust(evidence.state);
  const reasonCode = auditReasonCode(evidence.state);
  const summary = auditSummary(evidence.state);
  return {
    ...evidence,
    source,
    trust,
    reasonCode,
    summary,
    verified: false,
    gateEvidence: buildAuditGateEvidence(issueNumber, evidence.directory, evidence.state, summary, trust, reasonCode),
  };
}

function readEvidence(directory: string, issueNumber: number): UiAuditEvidence {
  const screenshotsDirectory = join(directory, 'screenshots');
  const notesPath = join(directory, 'notes.md');
  const browserObservationPath = join(directory, 'browser-observation.md');
  const directoryExists = existsSync(directory) && statSync(directory).isDirectory();
  const notesFound = hasNonEmptyFile(notesPath);
  const browserObservationFound = hasNonEmptyFile(browserObservationPath);
  const screenshotCount = countScreenshots(screenshotsDirectory);
  const missing: string[] = [];
  if (!directoryExists) missing.push('local evidence directory');
  if (directoryExists && !browserObservationFound) missing.push('browser-observation.md');
  if (directoryExists && screenshotCount === 0) missing.push('local screenshots');
  if (directoryExists && !notesFound) missing.push('notes.md visual analysis');
  const state: UiAuditEvidenceState = !directoryExists
    ? 'missing'
    : notesFound && browserObservationFound && screenshotCount > 0
      ? 'visual-analysis-recorded'
      : screenshotCount > 0
        ? 'screenshots-captured'
        : browserObservationFound
          ? 'browser-visited'
          : 'metadata-only';
  return withAuditEvidence(issueNumber, {
    directory: redact(directory),
    screenshotsDirectory: redact(screenshotsDirectory),
    notesPath: redact(notesPath),
    browserObservationPath: redact(browserObservationPath),
    directoryExists,
    notesFound,
    browserObservationFound,
    screenshotCount,
    state,
    missing,
  });
}

function disabledEvidence(directory: string, issueNumber: number): UiAuditEvidence {
  return withAuditEvidence(issueNumber, { ...readEvidence(directory, issueNumber), state: 'disabled', missing: [] });
}

function createDirectory(path: string, dryRun: boolean, created: string[]): void {
  if (existsSync(path)) return;
  if (!dryRun) mkdirSync(path, { recursive: true });
  created.push(redact(path));
}

function buildWarnings(config: Config): string[] {
  const warnings = [
    'Screenshot upload is out of scope and disabled by default; keep evidence local unless a future opt-in integration is configured.',
    'Executor never claims a UI audit passed from generated instructions, screenshots, browser observations, or local notes alone.',
  ];
  if (!config.uiAuditAppLaunch || !config.uiAuditTarget) {
    warnings.push('No app launch command or audit target URL is configured yet; use the repository-specific run command and record the real URL in browser-observation.md.');
  }
  if (!config.manualUiAudit) warnings.unshift('Manual UI audit is disabled by repository config.');
  return warnings;
}

function nextAction(result: Pick<UiAuditResult, 'required' | 'prepare' | 'check' | 'dryRun' | 'evidence'>): string {
  if (!result.required) return 'No manual UI audit is required by config; record why the UI audit does not apply before shipping UI work.';
  if (result.prepare && !result.dryRun) return 'Run the real application, audit it with agent-browser first, capture screenshots for important states, and write browser-observation.md plus notes.md visual analysis.';
  if (result.check) return result.evidence.state === 'visual-analysis-recorded'
    ? 'Inspect the local evidence yourself; Executor reports browser/screenshot evidence plus visual-analysis presence only and cannot certify that the audit passed.'
    : 'Create browser-observation.md, capture local screenshots, add notes.md visual analysis, then rerun `aie audit ui <issue> --check`.';
  return 'Run `aie audit ui <issue> --prepare`, audit the real running app with agent-browser first, capture screenshots, and record browser-observation.md plus notes.md visual analysis.';
}

export function runUiAudit(config: Config, options: UiAuditOptions): UiAuditResult {
  const dryRun = options.dryRun ?? false;
  const prepare = options.prepare ?? false;
  const check = options.check ?? false;
  const root = evidenceRoot(options.repoRoot, options.homeDirectory ?? homedir());
  const directory = join(root, String(options.issueNumber));
  const screenshotsDirectory = join(directory, 'screenshots');
  const createdDirectories: string[] = [];
  if (prepare) {
    createDirectory(directory, dryRun, createdDirectories);
    createDirectory(screenshotsDirectory, dryRun, createdDirectories);
  }
  const evidence = config.manualUiAudit ? readEvidence(directory, options.issueNumber) : disabledEvidence(directory, options.issueNumber);
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
    createdDirectories,
    checklist: CHECKLIST.map(item => ({ ...item })),
    warnings: buildWarnings(config),
    nextAction: '',
  };
  return { ...result, nextAction: nextAction(result) };
}

export function formatUiAudit(result: UiAuditResult): string {
  const lines = [`Manual UI audit for issue #${result.issue}: ${result.required ? 'required' : 'disabled by config'}.`];
  lines.push(`Evidence directory: ${result.evidence.directory}`);
  lines.push(`Browser observation: ${result.evidence.browserObservationPath}`);
  lines.push(`Visual analysis notes: ${result.evidence.notesPath}`);
  lines.push(`Screenshots directory: ${result.evidence.screenshotsDirectory}`);
  if (result.prepare) lines.push(result.dryRun ? 'Dry-run: would create local evidence directories if missing.' : 'Prepared local evidence directories if they were missing.');
  if (result.check) lines.push(`Evidence check: ${result.evidence.state}.`);
  lines.push(`Evidence source: ${result.evidence.source}/${result.evidence.trust}; reason=${result.evidence.reasonCode}.`);
  lines.push('Preferred browser: agent-browser.');
  lines.push(`Fallback: ${result.fallbackBrowserAutomation}`);
  lines.push(result.appLaunch
    ? `App launch: ${result.appLaunch}`
    : 'App launch: not configured; start the real application with the repository-specific command and record it in browser-observation.md.');
  lines.push(result.auditTarget
    ? `Audit target: ${result.auditTarget}`
    : 'Audit target: not configured; open the changed UI route in the real running app and record the URL in browser-observation.md.');
  lines.push('Checklist:');
  for (const item of result.checklist) {
    lines.push(`- ${item.title}: ${item.action}`);
  }
  if (result.evidence.missing.length > 0) lines.push(`Missing evidence: ${result.evidence.missing.join(', ')}.`);
  lines.push('Screenshot upload: disabled and out of scope; keep screenshots local by default.');
  lines.push('Executor reports audit guidance and local evidence state only; it never claims UI audit pass/fail from generated instructions, metadata, screenshots, browser observations, or local notes alone.');
  lines.push(`Next action: ${result.nextAction}`);
  return lines.join('\n');
}

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { validateAuditPng, type ValidatedAuditImage } from './audit_image.js';

export const UI_AUDIT_RECORD_NAME = 'audit.json';

export type UiAuditOutcome = 'passed' | 'failed' | 'blocked' | 'incomplete';

export interface UiAuditReason {
  code: string;
  message: string;
}

export interface UiAuditScreenshot extends ValidatedAuditImage {
  path: string;
}

export interface UiAuditAction {
  type: string;
  description: string;
}

export interface UiAuditStateRecord {
  id: string;
  name: string;
  url: string;
  viewport: { width: number; height: number };
  actions: UiAuditAction[];
  visibleOutcome: string;
  screenshot: { path: string; sha256: string };
  findings: string[];
  blockers: string[];
}

export interface UiAuditMatrixRecord {
  row: UiAuditMatrixRow;
  status: 'inspected' | 'not-applicable';
  stateIds: string[];
  reason: string | null;
}

export interface UiAuditSurfaceRecord {
  name: string;
  changedFlow: string;
  interactionRequired: boolean;
  states: UiAuditStateRecord[];
  matrix: UiAuditMatrixRecord[];
}

export interface UiAuditRecord {
  version: 1;
  outcome: Exclude<UiAuditOutcome, 'incomplete'>;
  headSha: string;
  targetUrl: string;
  browser: { name: string; sessionId: string | null };
  surfaces: UiAuditSurfaceRecord[];
  findings: string[];
  blockers: string[];
}

export interface UiAuditEvaluation {
  outcome: UiAuditOutcome;
  reportedOutcome: UiAuditRecord['outcome'] | null;
  reasons: UiAuditReason[];
  stale: boolean;
  record: UiAuditRecord | null;
  recordPath: string;
  recordDigest: string | null;
  screenshots: UiAuditScreenshot[];
}

const MATRIX_ROWS = [
  'initial-load',
  'changed-interaction',
  'affected-states',
  'keyboard-accessibility',
  'responsive-layout',
  'user-visible-failures',
] as const;
export type UiAuditMatrixRow = typeof MATRIX_ROWS[number];

const BROWSER_ACTIONS = new Set(['navigate', 'click', 'type', 'keyboard', 'scroll', 'select', 'submit', 'toggle', 'inspect']);
const INTERACTION_ACTIONS = new Set(['click', 'type', 'keyboard', 'select', 'submit', 'toggle']);
const SHA_PATTERN = /^[a-f0-9]{64}$/;
const HEAD_PATTERN = /^[a-f0-9]{7,40}$/;
const SCREENSHOT_PATTERN = /^screenshots\/([a-zA-Z0-9._-]+\.png)$/;

export function uiAuditRecordTemplate(headSha: string | null, targetUrl: string | null): UiAuditRecord {
  const stateId = 'primary-changed-state';
  return {
    version: 1,
    outcome: 'passed',
    headSha: headSha ?? '<current-head-sha>',
    targetUrl: targetUrl ?? 'http://127.0.0.1:<port>/<changed-route>',
    browser: { name: 'agent-browser', sessionId: '<browser-session-id>' },
    surfaces: [{
      name: '<affected-surface>',
      changedFlow: '<changed-flow>',
      interactionRequired: true,
      states: [{
        id: stateId,
        name: '<inspected-state>',
        url: targetUrl ?? 'http://127.0.0.1:<port>/<changed-route>',
        viewport: { width: 1280, height: 800 },
        actions: [
          { type: 'navigate', description: '<browser navigation>' },
          { type: 'click', description: '<relevant interaction>' },
          { type: 'inspect', description: '<visual and screenshot inspection>' },
        ],
        visibleOutcome: '<visible result>',
        screenshot: { path: 'screenshots/<state>.png', sha256: '<sha256>' },
        findings: [],
        blockers: [],
      }],
      matrix: MATRIX_ROWS.map(row => ({
        row,
        status: row === 'initial-load' || row === 'changed-interaction' ? 'inspected' : 'not-applicable',
        stateIds: row === 'initial-load' || row === 'changed-interaction' ? [stateId] : [],
        reason: row === 'initial-load' || row === 'changed-interaction' ? null : '<why this row is not affected>',
      })),
    }],
    findings: [],
    blockers: [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(nonEmptyString);
}

function validUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function sameCommit(left: string, right: string): boolean {
  const first = left.trim().toLowerCase();
  const second = right.trim().toLowerCase();
  return first.length >= 7 && second.length >= 7 && (first.startsWith(second) || second.startsWith(first));
}

function reason(reasons: UiAuditReason[], code: string, message: string): void {
  if (!reasons.some(item => item.code === code && item.message === message)) reasons.push({ code, message });
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: readonly string[], location: string, reasons: UiAuditReason[]): void {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(value)) if (!allowedKeys.has(key)) reason(reasons, 'unexpected-audit-field', `${location} contains unsupported field ${key}.`);
}

function parseState(value: unknown, location: string, reasons: UiAuditReason[]): UiAuditStateRecord | null {
  if (!isRecord(value)) {
    reason(reasons, 'malformed-state', `${location} must be an object.`);
    return null;
  }
  const reasonCountBeforeState = reasons.length;
  rejectUnknownKeys(value, ['id', 'name', 'url', 'viewport', 'actions', 'visibleOutcome', 'screenshot', 'findings', 'blockers'], location, reasons);
  const viewport = value.viewport;
  const screenshot = value.screenshot;
  const actions = value.actions;
  if (!nonEmptyString(value.id) || !nonEmptyString(value.name) || !nonEmptyString(value.url) || !validUrl(value.url)) reason(reasons, 'malformed-state', `${location} must record an id, name, and HTTP(S) URL.`);
  if (!isRecord(viewport) || !Number.isInteger(viewport.width) || !Number.isInteger(viewport.height) || Number(viewport.width) <= 0 || Number(viewport.height) <= 0) reason(reasons, 'malformed-viewport', `${location} must record a positive integer viewport width and height.`);
  else rejectUnknownKeys(viewport, ['width', 'height'], `${location}.viewport`, reasons);
  if (!Array.isArray(actions) || actions.length === 0) reason(reasons, 'missing-browser-actions', `${location} must record browser actions.`);
  const parsedActions: UiAuditAction[] = [];
  if (Array.isArray(actions)) {
    for (const [index, action] of actions.entries()) {
      if (!isRecord(action) || !nonEmptyString(action.type) || !BROWSER_ACTIONS.has(action.type) || !nonEmptyString(action.description)) reason(reasons, 'invalid-browser-action', `${location}.actions[${index}] must record a supported browser action and description.`);
      else {
        rejectUnknownKeys(action, ['type', 'description'], `${location}.actions[${index}]`, reasons);
        parsedActions.push({ type: action.type, description: action.description.trim() });
      }
    }
  }
  if (!nonEmptyString(value.visibleOutcome)) reason(reasons, 'missing-visual-observation', `${location} must record an explicit visible outcome.`);
  if (!isRecord(screenshot) || !nonEmptyString(screenshot.path) || !SCREENSHOT_PATTERN.test(screenshot.path) || !nonEmptyString(screenshot.sha256) || !SHA_PATTERN.test(screenshot.sha256.toLowerCase())) reason(reasons, 'invalid-screenshot-reference', `${location} must reference a canonical screenshots/*.png path and SHA-256.`);
  else rejectUnknownKeys(screenshot, ['path', 'sha256'], `${location}.screenshot`, reasons);
  if (!stringArray(value.findings) || !stringArray(value.blockers)) reason(reasons, 'malformed-state', `${location} findings and blockers must be string arrays.`);
  if (reasons.length > reasonCountBeforeState) return null;
  return {
    id: String(value.id).trim(),
    name: String(value.name).trim(),
    url: String(value.url).trim(),
    viewport: { width: Number((viewport as Record<string, unknown>).width), height: Number((viewport as Record<string, unknown>).height) },
    actions: parsedActions,
    visibleOutcome: String(value.visibleOutcome).trim(),
    screenshot: { path: String((screenshot as Record<string, unknown>).path), sha256: String((screenshot as Record<string, unknown>).sha256).toLowerCase() },
    findings: (value.findings as string[]).map(item => item.trim()),
    blockers: (value.blockers as string[]).map(item => item.trim()),
  };
}

function parseMatrix(value: unknown, location: string, reasons: UiAuditReason[]): UiAuditMatrixRecord[] {
  if (!Array.isArray(value)) {
    reason(reasons, 'missing-audit-matrix', `${location} must record every audit matrix row.`);
    return [];
  }
  const records: UiAuditMatrixRecord[] = [];
  for (const [index, item] of value.entries()) {
    if (!isRecord(item) || !MATRIX_ROWS.includes(item.row as UiAuditMatrixRow) || (item.status !== 'inspected' && item.status !== 'not-applicable') || !Array.isArray(item.stateIds) || !item.stateIds.every(nonEmptyString) || (item.reason !== null && !nonEmptyString(item.reason))) {
      reason(reasons, 'malformed-audit-matrix', `${location}[${index}] has an invalid row, status, stateIds, or reason.`);
      continue;
    }
    rejectUnknownKeys(item, ['row', 'status', 'stateIds', 'reason'], `${location}[${index}]`, reasons);
    const record: UiAuditMatrixRecord = { row: item.row as UiAuditMatrixRow, status: item.status, stateIds: item.stateIds.map(value => String(value).trim()), reason: item.reason === null ? null : String(item.reason).trim() };
    if (record.status === 'inspected' && record.stateIds.length === 0) reason(reasons, 'unproven-audit-matrix-row', `${location} row ${record.row} is inspected but references no state.`);
    if (record.status === 'not-applicable' && !record.reason) reason(reasons, 'missing-not-applicable-reason', `${location} row ${record.row} is not applicable but has no reason.`);
    records.push(record);
  }
  for (const row of MATRIX_ROWS) {
    const matches = records.filter(item => item.row === row);
    if (matches.length !== 1) reason(reasons, 'missing-audit-matrix-row', `${location} must contain exactly one ${row} row.`);
  }
  return records;
}

function parseRecord(value: unknown, reasons: UiAuditReason[]): UiAuditRecord | null {
  if (!isRecord(value)) {
    reason(reasons, 'malformed-audit-record', 'audit.json must contain one JSON object.');
    return null;
  }
  rejectUnknownKeys(value, ['version', 'outcome', 'headSha', 'targetUrl', 'browser', 'surfaces', 'findings', 'blockers'], 'audit.json', reasons);
  if (value.version !== 1) reason(reasons, 'unsupported-audit-version', 'audit.json version must be 1.');
  if (value.outcome !== 'passed' && value.outcome !== 'failed' && value.outcome !== 'blocked') reason(reasons, 'invalid-reported-outcome', 'audit.json outcome must be passed, failed, or blocked. Incomplete is derived when evidence is insufficient.');
  if (!nonEmptyString(value.headSha) || !HEAD_PATTERN.test(value.headSha.toLowerCase())) reason(reasons, 'invalid-audit-head', 'audit.json must record a valid repository head SHA.');
  if (!nonEmptyString(value.targetUrl) || !validUrl(value.targetUrl)) reason(reasons, 'invalid-audit-target', 'audit.json must record an HTTP(S) target URL.');
  if (!isRecord(value.browser) || !nonEmptyString(value.browser.name) || (value.browser.sessionId !== null && !nonEmptyString(value.browser.sessionId))) reason(reasons, 'invalid-browser-session', 'audit.json must record a browser name and a session id or null when browser control is blocked.');
  else rejectUnknownKeys(value.browser, ['name', 'sessionId'], 'audit.json browser', reasons);
  if (!stringArray(value.findings) || !stringArray(value.blockers)) reason(reasons, 'malformed-audit-record', 'audit.json findings and blockers must be string arrays.');
  if (!Array.isArray(value.surfaces)) reason(reasons, 'malformed-audit-record', 'audit.json surfaces must be an array.');
  if (reasons.some(item => ['unsupported-audit-version', 'invalid-reported-outcome', 'invalid-audit-head', 'invalid-audit-target', 'invalid-browser-session', 'malformed-audit-record'].includes(item.code))) return null;

  const surfaces: UiAuditSurfaceRecord[] = [];
  for (const [surfaceIndex, surfaceValue] of (value.surfaces as unknown[]).entries()) {
    const location = `surfaces[${surfaceIndex}]`;
    if (!isRecord(surfaceValue) || !nonEmptyString(surfaceValue.name) || !nonEmptyString(surfaceValue.changedFlow) || typeof surfaceValue.interactionRequired !== 'boolean' || !Array.isArray(surfaceValue.states)) {
      reason(reasons, 'malformed-surface', `${location} must record name, changedFlow, interactionRequired, states, and matrix.`);
      continue;
    }
    rejectUnknownKeys(surfaceValue, ['name', 'changedFlow', 'interactionRequired', 'states', 'matrix'], location, reasons);
    const states = surfaceValue.states.flatMap((state, stateIndex) => {
      const parsed = parseState(state, `${location}.states[${stateIndex}]`, reasons);
      return parsed ? [parsed] : [];
    });
    const ids = new Set<string>();
    for (const state of states) {
      if (ids.has(state.id)) reason(reasons, 'duplicate-state-id', `${location} repeats state id ${state.id}.`);
      ids.add(state.id);
      if (state.url !== String(value.targetUrl) && !state.url.startsWith(`${String(value.targetUrl).replace(/\/$/, '')}/`)) reason(reasons, 'state-target-mismatch', `${location} state ${state.id} is outside the recorded target URL.`);
    }
    const matrix = parseMatrix(surfaceValue.matrix, `${location}.matrix`, reasons);
    for (const row of matrix) for (const stateId of row.stateIds) if (!ids.has(stateId)) reason(reasons, 'unknown-matrix-state', `${location} matrix row ${row.row} references unknown state ${stateId}.`);
    if (states.length === 0 && value.outcome !== 'blocked') reason(reasons, 'missing-inspected-state', `${location} must record at least one inspected state.`);
    if (states.length > 0 && !states.some(state => state.actions.some(action => action.type === 'navigate'))) reason(reasons, 'missing-browser-navigation', `${location} must include at least one real browser navigation action.`);
    if (surfaceValue.interactionRequired && !states.some(state => state.actions.some(action => INTERACTION_ACTIONS.has(action.type)))) reason(reasons, 'missing-relevant-interaction', `${location} requires an interaction but records only navigation or inspection.`);
    surfaces.push({
      name: surfaceValue.name.trim(),
      changedFlow: surfaceValue.changedFlow.trim(),
      interactionRequired: surfaceValue.interactionRequired,
      states,
      matrix,
    });
  }
  return {
    version: 1,
    outcome: value.outcome as UiAuditRecord['outcome'],
    headSha: String(value.headSha).toLowerCase(),
    targetUrl: String(value.targetUrl),
    browser: { name: String((value.browser as Record<string, unknown>).name).trim(), sessionId: (value.browser as Record<string, unknown>).sessionId === null ? null : String((value.browser as Record<string, unknown>).sessionId).trim() },
    surfaces,
    findings: (value.findings as string[]).map(item => item.trim()),
    blockers: (value.blockers as string[]).map(item => item.trim()),
  };
}

export function evaluateUiAuditRecord(directory: string, currentHead: string | null): UiAuditEvaluation {
  const recordPath = join(directory, UI_AUDIT_RECORD_NAME);
  const reasons: UiAuditReason[] = [];
  if (!existsSync(recordPath)) {
    reason(reasons, 'missing-audit-record', `Create ${UI_AUDIT_RECORD_NAME} with a browser-observed audit outcome.`);
    return { outcome: 'incomplete', reportedOutcome: null, reasons, stale: false, record: null, recordPath, recordDigest: null, screenshots: [] };
  }
  const recordInfo = lstatSync(recordPath);
  if (!recordInfo.isFile() || recordInfo.isSymbolicLink()) {
    reason(reasons, 'malformed-audit-record', `${UI_AUDIT_RECORD_NAME} must be a regular local file.`);
    return { outcome: 'incomplete', reportedOutcome: null, reasons, stale: false, record: null, recordPath, recordDigest: null, screenshots: [] };
  }
  let raw: string;
  let parsed: unknown;
  try {
    raw = readFileSync(recordPath, 'utf8');
    parsed = JSON.parse(raw);
  } catch {
    reason(reasons, 'malformed-audit-record', `${UI_AUDIT_RECORD_NAME} is not valid UTF-8 JSON.`);
    return { outcome: 'incomplete', reportedOutcome: null, reasons, stale: false, record: null, recordPath, recordDigest: null, screenshots: [] };
  }
  const record = parseRecord(parsed, reasons);
  const reportedOutcome = record?.outcome ?? null;
  const recordDigest = createHash('sha256').update(raw).digest('hex');
  if (!record) return { outcome: 'incomplete', reportedOutcome, reasons, stale: false, record: null, recordPath, recordDigest, screenshots: [] };
  if (!currentHead) reason(reasons, 'current-head-unavailable', 'The current repository head could not be resolved.');
  else if (!sameCommit(currentHead, record.headSha)) reason(reasons, 'stale-audit-head', `The audit records head ${record.headSha}, not current head ${currentHead}.`);
  const stale = reasons.some(item => item.code === 'stale-audit-head');

  if (record.outcome === 'blocked') {
    const blockers = [...record.blockers, ...record.surfaces.flatMap(surface => surface.states.flatMap(state => state.blockers))];
    if (blockers.length === 0) reason(reasons, 'missing-audit-blocker', 'A blocked audit must record the exact browser or application blocker.');
    if (reasons.length > 0) return { outcome: 'incomplete', reportedOutcome, reasons, stale, record, recordPath, recordDigest, screenshots: [] };
    reason(reasons, 'audit-blocked', blockers.join(' '));
    return { outcome: 'blocked', reportedOutcome, reasons, stale, record, recordPath, recordDigest, screenshots: [] };
  }
  if (!record.browser.sessionId) reason(reasons, 'missing-browser-session', 'A passed or failed audit must record the browser session id used for observation.');
  if (record.surfaces.length === 0) reason(reasons, 'missing-audit-surface', 'A passed or failed audit must record at least one affected surface.');

  const screenshots: UiAuditScreenshot[] = [];
  const referenced = new Set<string>();
  const screenshotDirectory = join(directory, 'screenshots');
  let screenshotDirectorySafe = false;
  try {
    const info = lstatSync(screenshotDirectory);
    screenshotDirectorySafe = info.isDirectory() && !info.isSymbolicLink();
  } catch {
    screenshotDirectorySafe = false;
  }
  if (!screenshotDirectorySafe) reason(reasons, 'invalid-screenshot-directory', 'The screenshots path must be a regular local directory.');
  for (const surface of record.surfaces) {
    for (const state of surface.states) {
      const match = SCREENSHOT_PATTERN.exec(state.screenshot.path);
      if (!match) continue;
      const fileName = match[1];
      if (basename(fileName) !== fileName) {
        reason(reasons, 'invalid-screenshot-reference', `Screenshot ${state.screenshot.path} is not a canonical local filename.`);
        continue;
      }
      if (referenced.has(fileName)) {
        reason(reasons, 'duplicate-screenshot-reference', `Screenshot ${state.screenshot.path} is reused by more than one inspected state.`);
        continue;
      }
      referenced.add(fileName);
      if (!screenshotDirectorySafe) continue;
      const screenshotPath = join(directory, 'screenshots', fileName);
      try {
        const info = lstatSync(screenshotPath);
        if (!info.isFile() || info.isSymbolicLink()) {
          reason(reasons, 'invalid-screenshot', `Screenshot ${state.screenshot.path} must be a regular local file.`);
          continue;
        }
      } catch {
        reason(reasons, 'invalid-screenshot', `Screenshot ${state.screenshot.path} could not be read.`);
        continue;
      }
      const validation = validateAuditPng(screenshotPath);
      if (!validation.ok) {
        reason(reasons, 'invalid-screenshot', `Screenshot ${state.screenshot.path} ${validation.reason}.`);
        continue;
      }
      if (validation.image.sha256 !== state.screenshot.sha256) {
        reason(reasons, 'screenshot-hash-mismatch', `Screenshot ${state.screenshot.path} does not match its recorded SHA-256.`);
        continue;
      }
      screenshots.push({ path: state.screenshot.path, ...validation.image });
    }
  }
  if (screenshotDirectorySafe) {
    for (const name of readdirSync(screenshotDirectory).filter(name => name.toLowerCase().endsWith('.png'))) if (!referenced.has(name)) reason(reasons, 'unreferenced-screenshot', `Screenshot screenshots/${name} is not referenced by an inspected visual state.`);
  }
  const findings = [...record.findings, ...record.surfaces.flatMap(surface => surface.states.flatMap(state => state.findings))];
  const blockers = [...record.blockers, ...record.surfaces.flatMap(surface => surface.states.flatMap(state => state.blockers))];
  if (blockers.length > 0) reason(reasons, 'unexpected-audit-blocker', 'A passed or failed audit contains an operational blocker; report outcome blocked.');
  if (record.outcome === 'failed' && findings.length === 0) reason(reasons, 'missing-audit-finding', 'A failed audit must record at least one visible finding.');
  const structuralReasons = reasons.filter(item => item.code !== 'visible-audit-finding');
  if (structuralReasons.length > 0) return { outcome: 'incomplete', reportedOutcome, reasons, stale, record, recordPath, recordDigest, screenshots };
  if (findings.length > 0) {
    reason(reasons, 'visible-audit-finding', findings.join(' '));
    return { outcome: 'failed', reportedOutcome, reasons, stale, record, recordPath, recordDigest, screenshots };
  }
  return { outcome: 'passed', reportedOutcome, reasons, stale, record, recordPath, recordDigest, screenshots };
}

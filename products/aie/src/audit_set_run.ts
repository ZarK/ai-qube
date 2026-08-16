import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { pathHasParentSegment } from './audit.js';
import type { Config } from './config/index.js';

export const AUDIT_UI_SET_RUN_COMMAND = 'audit ui set-run';

export type AuditRunFields = {
  readonly command: string;
  readonly url: string;
};

export type SetAuditRunResult = {
  readonly ok: boolean;
  readonly command: typeof AUDIT_UI_SET_RUN_COMMAND;
  readonly dryRun: boolean;
  readonly applied: boolean;
  readonly configPath: string;
  readonly appLaunch: string | null;
  readonly target: string | null;
  readonly error?: string;
  readonly nextAction: string;
};

export function parseAuditRunFields(command: string | undefined, url: string | undefined):
  | { readonly ok: true; readonly fields: AuditRunFields }
  | { readonly ok: false; readonly reason: string } {
  const trimmedCommand = (command ?? '').trim();
  const trimmedUrl = (url ?? '').trim();
  if (trimmedCommand === '') {
    return { ok: false, reason: 'audit ui set-run requires --command. Pass the start command that already worked.' };
  }
  if (trimmedUrl === '') {
    return { ok: false, reason: 'audit ui set-run requires --url. Pass the ready URL that already worked.' };
  }
  if (trimmedCommand.includes('\0')) {
    return { ok: false, reason: '--command must not contain a null byte.' };
  }
  if (pathHasParentSegment(trimmedUrl)) {
    return { ok: false, reason: '--url must not contain parent-directory segments.' };
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmedUrl);
  } catch {
    return { ok: false, reason: '--url must be an absolute http or https URL.' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: '--url must be an http or https URL.' };
  }
  return { ok: true, fields: { command: trimmedCommand, url: trimmedUrl } };
}

export function setAuditRun(input: {
  readonly config: Config | null;
  readonly configPath: string;
  readonly command?: string;
  readonly url?: string;
  readonly dryRun?: boolean;
}): SetAuditRunResult {
  if (!input.config) {
    return {
      ok: false,
      command: AUDIT_UI_SET_RUN_COMMAND,
      dryRun: input.dryRun === true,
      applied: false,
      configPath: input.configPath,
      appLaunch: null,
      target: null,
      error: 'No Executor config is present. Run `aie init` first, then record the working audit start command.',
      nextAction: 'Run `aie init . --yes`, then rerun `aie audit ui set-run --command <command> --url <url>`.',
    };
  }
  const parsed = parseAuditRunFields(input.command, input.url);
  if (!parsed.ok) {
    return {
      ok: false,
      command: AUDIT_UI_SET_RUN_COMMAND,
      dryRun: input.dryRun === true,
      applied: false,
      configPath: input.configPath,
      appLaunch: input.config.uiAuditAppLaunch || null,
      target: input.config.uiAuditTarget || null,
      error: parsed.reason,
      nextAction: 'Pass both --command and --url from a start command and ready URL that already worked.',
    };
  }
  if (input.dryRun !== true) {
    const written = writeCommittedAuditRunFields(input.configPath, parsed.fields);
    if (!written.ok) {
      return {
        ok: false,
        command: AUDIT_UI_SET_RUN_COMMAND,
        dryRun: false,
        applied: false,
        configPath: input.configPath,
        appLaunch: input.config.uiAuditAppLaunch || null,
        target: input.config.uiAuditTarget || null,
        error: written.reason,
        nextAction: 'Fix the committed Executor config file, then rerun `aie audit ui set-run`.',
      };
    }
  }
  return {
    ok: true,
    command: AUDIT_UI_SET_RUN_COMMAND,
    dryRun: input.dryRun === true,
    applied: input.dryRun !== true,
    configPath: input.configPath,
    appLaunch: parsed.fields.command,
    target: parsed.fields.url,
    nextAction: input.dryRun === true
      ? 'Rerun without --dry-run to write policy.audit.appLaunch and policy.audit.target.'
      : 'Later audits can reuse the saved command and URL. Pass an explicit run-start command to override.',
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function writeCommittedAuditRunFields(configPath: string, fields: AuditRunFields): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  if (!existsSync(configPath)) {
    return { ok: false, reason: `Committed Executor config is missing at ${configPath}.` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `Failed to read the committed Executor config: ${message}` };
  }
  if (!isRecord(raw)) {
    return { ok: false, reason: 'Committed Executor config must be a JSON object.' };
  }
  const policy = isRecord(raw.policy) ? { ...raw.policy } : {};
  const audit = isRecord(policy.audit) ? { ...policy.audit } : {};
  audit.appLaunch = fields.command;
  audit.target = fields.url;
  policy.audit = audit;
  raw.policy = policy;
  writeFileSync(configPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
  return { ok: true };
}

export function formatSetAuditRun(result: SetAuditRunResult): string {
  const lines = [
    result.ok
      ? (result.applied ? 'Recorded the UI audit run command and ready URL.' : 'Planned the UI audit run command and ready URL.')
      : `Failed to record the UI audit run command. ${result.error}`,
    `Config: ${result.configPath}`,
    `App launch: ${result.appLaunch ?? '(empty)'}`,
    `Ready URL: ${result.target ?? '(empty)'}`,
    result.nextAction,
  ];
  return `${lines.join('\n')}\n`;
}

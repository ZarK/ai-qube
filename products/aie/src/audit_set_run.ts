import { writeFileSync } from 'node:fs';
import { formatConfigFile, type Config } from './config/index.js';

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
  if (trimmedUrl.split(/[/\\]/).some(segment => segment === '..')) {
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

export function applyAuditRunToConfig(config: Config, fields: AuditRunFields): Config {
  return {
    ...config,
    uiAuditAppLaunch: fields.command,
    uiAuditTarget: fields.url,
    policy: {
      ...config.policy,
      audit: {
        ...config.policy.audit,
        appLaunch: fields.command,
        target: fields.url,
      },
    },
  };
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
  const next = applyAuditRunToConfig(input.config, parsed.fields);
  if (input.dryRun !== true) {
    writeFileSync(input.configPath, formatConfigFile(next), 'utf8');
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

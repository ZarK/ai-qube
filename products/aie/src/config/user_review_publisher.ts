import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import type { GitHubReviewPublisherConfig, ValidationError } from './types.js';

export const USER_REVIEW_PUBLISHER_PATH = '.qube/aie/review-publisher.json';

export interface UserReviewPublisherParseResult {
  readonly ok: boolean;
  readonly errors: readonly ValidationError[];
  readonly publisher?: Readonly<Record<string, unknown>>;
}

export function defaultUserHomeDirectory(): string {
  return process.env.USERPROFILE ?? process.env.HOME ?? homedir();
}

export function userReviewPublisherPath(homeDirectory = defaultUserHomeDirectory()): string {
  return join(resolve(homeDirectory), ...USER_REVIEW_PUBLISHER_PATH.split('/'));
}

export function parseUserReviewPublisherFile(value: unknown): UserReviewPublisherParseResult {
  const errors: ValidationError[] = [];
  if (!isRecord(value)) {
    return { ok: false, errors: [{ kind: 'invalid', path: USER_REVIEW_PUBLISHER_PATH, message: 'User-global review publisher config must be an object.' }] };
  }
  rejectUnknown(value, ['version', 'publisher'], '', errors);
  if (value.version !== 1) errors.push({ kind: 'invalid', path: 'version', message: 'User-global review publisher config version must be 1.' });
  if (!isRecord(value.publisher)) {
    errors.push({ kind: 'invalid', path: 'publisher', message: 'User-global review publisher config requires a publisher object.' });
    return { ok: false, errors };
  }
  const publisher = value.publisher;
  rejectUnknown(publisher, ['mode', 'githubApp'], 'publisher', errors);
  if (publisher.mode !== undefined && publisher.mode !== 'github-app') {
    errors.push({ kind: 'invalid', path: 'publisher.mode', message: 'User-global review publisher mode must be github-app.' });
  }
  if (!isRecord(publisher.githubApp)) {
    errors.push({ kind: 'invalid', path: 'publisher.githubApp', message: 'User-global review publisher config requires a githubApp object.' });
    return { ok: false, errors };
  }
  const app = publisher.githubApp;
  rejectUnknown(app, ['appId', 'installationId', 'privateKeyPath', 'privateKeyEnv', 'login'], 'publisher.githubApp', errors);
  validateNumeric(app.appId, 'publisher.githubApp.appId', errors);
  validateNumeric(app.installationId, 'publisher.githubApp.installationId', errors);
  validateReference(app.privateKeyEnv, 'publisher.githubApp.privateKeyEnv', 'env', errors);
  validateReference(app.privateKeyPath, 'publisher.githubApp.privateKeyPath', 'path', errors);
  validateLogin(app.login, errors);
  if (app.privateKeyEnv !== undefined && app.privateKeyPath !== undefined) {
    errors.push({ kind: 'invalid', path: 'publisher.githubApp', message: 'User-global review publisher config accepts only one private-key reference.' });
  }
  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, errors: [], publisher: freezeRecord({ mode: publisher.mode ?? 'github-app', githubApp: { ...app } }) };
}

export function formatUserReviewPublisherFile(publisher: GitHubReviewPublisherConfig): string {
  const parsed = parseUserReviewPublisherFile({ version: 1, publisher });
  if (!parsed.ok) {
    const first = parsed.errors[0];
    throw new TypeError(first?.message ?? 'User-global review publisher config is invalid.');
  }
  return `${JSON.stringify({ version: 1, publisher: parsed.publisher }, null, 2)}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function freezeRecord(value: Record<string, unknown>): Readonly<Record<string, unknown>> {
  const githubApp = isRecord(value.githubApp) ? Object.freeze({ ...value.githubApp }) : value.githubApp;
  return Object.freeze({ ...value, ...(githubApp ? { githubApp } : {}) });
}

function rejectUnknown(value: Record<string, unknown>, allowed: readonly string[], path: string, errors: ValidationError[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) errors.push({ kind: 'unknown', path: path ? `${path}.${key}` : key, message: `${path ? `${path}.` : ''}${key} is not supported in user-global review publisher config.` });
  }
}

function validateNumeric(value: unknown, path: string, errors: ValidationError[]): void {
  if (value === undefined) return;
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) errors.push({ kind: 'invalid', path, message: `${path} must be a positive decimal GitHub identifier.` });
}

function validateReference(value: unknown, path: string, kind: 'env' | 'path', errors: ValidationError[]): void {
  if (value === undefined) return;
  if (typeof value !== 'string' || value.trim() === '' || looksLikeSecret(value)) {
    errors.push({ kind: 'invalid', path, message: `${path} must be a safe ${kind === 'env' ? 'environment variable name' : 'local filesystem path'}, never credential material.` });
    return;
  }
  if (kind === 'env' && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) errors.push({ kind: 'invalid', path, message: `${path} must be a valid environment variable name.` });
}

function validateLogin(value: unknown, errors: ValidationError[]): void {
  if (value === undefined) return;
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._\[\]-]*$/.test(value) || looksLikeSecret(value)) {
    errors.push({ kind: 'invalid', path: 'publisher.githubApp.login', message: 'publisher.githubApp.login must be a public bot login.' });
  }
}

function looksLikeSecret(value: string): boolean {
  return value.includes('\n') || value.includes('\r') || /BEGIN [A-Z ]*PRIVATE KEY|github_pat_|gh[pousr]_/i.test(value);
}

export const LOCAL_RUNTIME_GITIGNORE_RULES = [
  '.qube/aie/reviews/',
  '.qube/aie/gates/',
  '.qube/aie/runs/',
  '.qube/aie/config.local.json',
  '.qube/aiq/out/',
  '.qube/aiq/progress.json',
] as const;

export const TRACKED_QUBE_CONFIG_PATHS = [
  '.qube/aie/config.json',
  '.qube/aie/review-learnings.json',
  '.qube/aiq/config.json',
] as const;

export const LOCAL_RUNTIME_GITIGNORE_HEADER = '# Local Executor and AIQ runtime files.';

export type LocalRuntimeGitignoreOperation = 'create' | 'append' | 'unchanged';

export interface LocalRuntimeGitignorePlan {
  operation: LocalRuntimeGitignoreOperation;
  content: string | null;
  missing: string[];
  reason: string;
}

function normalizeIgnoreLine(line: string): string | null {
  const withoutInlineComment = line.replace(/(^|\s)#.*$/, '$1').trim();
  if (withoutInlineComment === '') return null;
  return withoutInlineComment.replace(/\\/g, '/');
}

function stripTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function stripDirectoryGlob(value: string): string {
  if (value.endsWith('/**/*')) return value.slice(0, -5);
  if (value.endsWith('/**')) return value.slice(0, -3);
  if (value.endsWith('/*')) return value.slice(0, -2);
  return stripTrailingSlash(value);
}

export function lineCoversRule(line: string, rule: string): boolean {
  const normalized = normalizeIgnoreLine(line);
  if (normalized === null || normalized.startsWith('!')) return false;
  if (normalized === '*' || normalized === '**') return true;
  const rulePath = stripTrailingSlash(rule);
  if (stripTrailingSlash(normalized) === rulePath) return true;
  const parent = stripDirectoryGlob(normalized);
  if (parent === '' || /[*?\[]/.test(parent)) return false;
  return rulePath === parent || rulePath.startsWith(`${parent}/`);
}

export function ruleWouldIgnorePath(rule: string, path: string): boolean {
  return lineCoversRule(rule, path);
}

export function missingLocalRuntimeGitignoreRules(existingContent: string | null): string[] {
  if (existingContent === null) return [...LOCAL_RUNTIME_GITIGNORE_RULES];
  const lines = existingContent.split(/\r?\n/);
  return LOCAL_RUNTIME_GITIGNORE_RULES.filter((rule) => !lines.some((line) => lineCoversRule(line, rule)));
}

function hasHeader(existingContent: string): boolean {
  return existingContent.split(/\r?\n/).some((line) => line.trim() === LOCAL_RUNTIME_GITIGNORE_HEADER);
}

function renderRuleBlock(existingContent: string | null, missing: readonly string[]): string {
  const lines = existingContent !== null && hasHeader(existingContent) ? [...missing] : [LOCAL_RUNTIME_GITIGNORE_HEADER, ...missing];
  return `${lines.join('\n')}\n`;
}

export function planLocalRuntimeGitignoreUpdate(existingContent: string | null): LocalRuntimeGitignorePlan {
  const missing = missingLocalRuntimeGitignoreRules(existingContent);
  if (missing.length === 0) {
    return {
      operation: 'unchanged',
      content: existingContent,
      missing,
      reason: 'Gitignore already ignores local Executor and AIQ runtime files.',
    };
  }
  const block = renderRuleBlock(existingContent, missing);
  if (existingContent === null) {
    return {
      operation: 'create',
      content: block,
      missing,
      reason: 'Gitignore will be created with local Executor and AIQ runtime ignore rules.',
    };
  }
  const separator = existingContent.endsWith('\n') ? '' : '\n';
  return {
    operation: 'append',
    content: `${existingContent}${separator}${block}`,
    missing,
    reason: `Gitignore will append missing local runtime rules: ${missing.join(', ')}.`,
  };
}

export function writtenRulesCoverTrackedConfig(): boolean {
  return TRACKED_QUBE_CONFIG_PATHS.some((path) => LOCAL_RUNTIME_GITIGNORE_RULES.some((rule) => ruleWouldIgnorePath(rule, path)));
}

const MISSING_PACKAGE_CODES = new Set([
  'ERR_MODULE_NOT_FOUND',
  'MODULE_NOT_FOUND',
  'ERR_PACKAGE_PATH_NOT_EXPORTED',
]);

export function isMissingAdapterPackage(error: unknown, packageName: string): boolean {
  if (!(error instanceof Error)) return false;
  const code = 'code' in error ? String((error as { code?: unknown }).code) : '';
  const message = error.message.replace(/\\/g, '/');
  const needle = packageName.replace(/\\/g, '/');
  if (!message.includes(needle)) return false;
  if (MISSING_PACKAGE_CODES.has(code)) return true;
  return /cannot find package|cannot find module/i.test(message);
}

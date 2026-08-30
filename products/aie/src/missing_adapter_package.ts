const MISSING_PACKAGE_CODES = new Set([
  'ERR_MODULE_NOT_FOUND',
  'MODULE_NOT_FOUND',
  'ERR_PACKAGE_PATH_NOT_EXPORTED',
]);

const ADAPTER_PACKAGE_VERSIONS: Readonly<Record<string, string>> = Object.freeze({
  '@tjalve/qube-adapter-github': '0.1.8',
  '@tjalve/qube-adapter-gitlab': '0.1.8',
  '@tjalve/qube-adapter-linear': '0.1.6',
  '@tjalve/qube-adapter-jira': '0.1.6',
  '@tjalve/qube-adapter-jenkins': '0.1.6',
});

export function adapterInstallAndInitGuidance(packageName: string, initOptions: string): string {
  const version = ADAPTER_PACKAGE_VERSIONS[packageName];
  const spec = version ? `${packageName}@${version}` : packageName;
  return [
    `Run \`npm install --save-exact --ignore-scripts ${spec}\` or \`pnpm add --save-exact --ignore-scripts ${spec}\` for the package placement that owns QUBE.`,
    `Then rerun \`qube init ${initOptions}\`.`,
  ].join(' ');
}

export function isMissingAdapterPackage(error: unknown, packageName: string): boolean {
  if (!(error instanceof Error)) return false;
  const code = 'code' in error ? String((error as { code?: unknown }).code) : '';
  const message = error.message.replace(/\\/g, '/');
  const needle = packageName.replace(/\\/g, '/');
  if (!message.includes(needle)) return false;
  if (MISSING_PACKAGE_CODES.has(code)) return true;
  return /cannot find package|cannot find module/i.test(message);
}

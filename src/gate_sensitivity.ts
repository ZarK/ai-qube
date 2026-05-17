const SUPPLY_CHAIN_PATTERNS: RegExp[] = [
  /\b(npm|npx|pnpm|yarn|bun|bunx|corepack)\b/i,
  /\b(pip|pipx|uv|uvx|poetry|pipenv|hatch|rye|conda)\b/i,
  /\b(cargo|go\s+mod|go\s+install|mvn|gradle|gem|bundle|pod|carthage|swift\s+package)\b/i,
  /\b(brew|port|nix|choco|winget|scoop|vcpkg|apt|yum|dnf|apk)\b/i,
  /\b(curl|wget)\b.*\|\s*(sh|bash|zsh|pwsh|powershell)\b/i,
  /\b(create-|init|generate|scaffold|archetype:generate)\b/i,
  /\b(docker\s+pull|docker\s+build|helm\s+install|kubectl\s+apply|terraform\s+init)\b/i,
  /(?:\.github\/workflows\b|\b(action|workflow(?:s)?|release|publish|deploy)\b)/i,
  /\b(mcp|ide|extension|copilot|claude|codex|opencode|agent-tool|agent\s+tool)\b/i,
];

export function isSupplyChainSensitive(command: string): boolean {
  return SUPPLY_CHAIN_PATTERNS.some(pattern => pattern.test(command));
}

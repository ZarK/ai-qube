export interface ScenarioDefinition {
  id: string;
  stages: string[];
  tags: string[];
}

export function createScenarioCatalog(names: readonly string[]): ScenarioDefinition[] {
  return names.map((name, index) => ({
    id: `${name}-${index + 1}`,
    stages: index % 2 === 0 ? ["lint", "typecheck"] : ["lint", "coverage"],
    tags: index % 3 === 0 ? ["ci", "default"] : ["default"],
  }));
}

export function listScenarioIds(catalog: readonly ScenarioDefinition[]): string[] {
  return catalog.map((scenario) => scenario.id);
}

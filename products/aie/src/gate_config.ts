import type { GateConfig } from './config/index.js';

export function buildQualityGate(command: string, index: number): GateConfig {
  return {
    name: `quality-gate-${index + 1}`,
    kind: 'custom',
    command,
    stage: 'all',
    required: true,
    timeoutSeconds: 600,
    workingDirectory: '.',
    env: {},
    externalService: false,
  };
}

export function expandGateConfigs(gates: GateConfig[], qualityGates: string[], qualityControl: boolean): GateConfig[] {
  return [...gates, ...qualityGates.map(buildQualityGate)]
    .filter(gate => gate.kind !== 'aiq' || qualityControl);
}

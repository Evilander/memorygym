import { listAdapters } from './adapters/baselines.js';

export function buildScenarioManifest(scenarioPack) {
  const dimensions = new Map();
  const tags = new Map();
  const probeKinds = new Map();
  const capabilityRequirements = new Map();
  let eventCount = 0;
  let probeCount = 0;

  for (const scenario of scenarioPack.scenarios) {
    eventCount += scenario.events.length;
    probeCount += scenario.probes.length;
    for (const dimension of scenario.dimensions ?? []) {
      dimensions.set(dimension, (dimensions.get(dimension) ?? 0) + 1);
    }
    for (const tag of scenario.tags ?? []) {
      tags.set(tag, (tags.get(tag) ?? 0) + 1);
    }
    for (const event of scenario.events) {
      for (const tag of event.tags ?? []) {
        tags.set(tag, (tags.get(tag) ?? 0) + 1);
      }
    }
    for (const probe of scenario.probes) {
      const kind = probe.kind ?? 'recall';
      probeKinds.set(kind, (probeKinds.get(kind) ?? 0) + 1);
      for (const capability of probe.requires ?? []) {
        capabilityRequirements.set(capability, (capabilityRequirements.get(capability) ?? 0) + 1);
      }
    }
  }

  return {
    name: scenarioPack.name,
    version: scenarioPack.version,
    scenarioCount: scenarioPack.scenarios.length,
    eventCount,
    probeCount,
    dimensions: toSortedEntries(dimensions),
    probeKinds: toSortedEntries(probeKinds),
    capabilityRequirements: toSortedEntries(capabilityRequirements),
    tags: toSortedEntries(tags),
    gates: scenarioPack.gates ?? {},
    adapters: {
      local: listAdapters(),
      external: ['audrey-mcp', 'audrey-http']
    }
  };
}

function toSortedEntries(map) {
  return [...map.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([name, count]) => ({ name, count }));
}

import { tokenSet } from './text.js';

export function lintScenarioPack(scenarioPack, options = {}) {
  const findings = [];
  const scenarioIds = new Set();
  const eventIds = new Set();
  const probeIds = new Set();
  const dimensions = new Map();
  const strict = Boolean(options.strict);

  if (!scenarioPack.name) {
    add(findings, 'error', 'suite-name-missing', 'Scenario pack is missing name');
  }
  if (!scenarioPack.version) {
    add(findings, strict ? 'error' : 'warn', 'suite-version-missing', 'Scenario pack is missing version');
  }
  if (!scenarioPack.gates) {
    add(findings, strict ? 'error' : 'warn', 'suite-gates-missing', 'Scenario pack has no gates');
  }

  for (const scenario of scenarioPack.scenarios ?? []) {
    if (scenarioIds.has(scenario.id)) {
      add(findings, 'error', 'duplicate-scenario-id', `Duplicate scenario id: ${scenario.id}`);
    }
    scenarioIds.add(scenario.id);

    if ((scenario.dimensions ?? []).length === 0) {
      add(findings, strict ? 'error' : 'warn', 'scenario-dimensions-missing', `${scenario.id} has no dimensions`);
    }
    if ((scenario.tags ?? []).length === 0) {
      add(findings, 'warn', 'scenario-tags-missing', `${scenario.id} has no tags`);
    }
    for (const dimension of scenario.dimensions ?? []) {
      dimensions.set(dimension, (dimensions.get(dimension) ?? 0) + 1);
    }

    const localEventIds = new Set();
    for (const event of scenario.events ?? []) {
      if (eventIds.has(event.id)) {
        add(findings, 'error', 'duplicate-event-id', `Duplicate event id across pack: ${event.id}`);
      }
      if (localEventIds.has(event.id)) {
        add(findings, 'error', 'duplicate-scenario-event-id', `${scenario.id} duplicates event id ${event.id}`);
      }
      eventIds.add(event.id);
      localEventIds.add(event.id);

      if (!event.type) {
        add(findings, strict ? 'error' : 'warn', 'event-type-missing', `${event.id} has no memory type`);
      }
      if (String(event.content ?? '').trim().length < 40) {
        add(findings, 'warn', 'event-content-thin', `${event.id} content is too short to be a useful memory`);
      }
      if (event.salience !== undefined && (event.salience < 0 || event.salience > 1)) {
        add(findings, 'error', 'event-salience-range', `${event.id} salience must be between 0 and 1`);
      }
    }

    for (const probe of scenario.probes ?? []) {
      const fullProbeId = `${scenario.id}/${probe.id}`;
      if (probeIds.has(fullProbeId)) {
        add(findings, 'error', 'duplicate-probe-id', `Duplicate probe id: ${fullProbeId}`);
      }
      probeIds.add(fullProbeId);

      const probeKind = probe.kind ?? 'recall';
      if (!['recall', 'abstention', 'capability'].includes(probeKind)) {
        add(findings, 'error', 'probe-kind-unknown', `${fullProbeId} has unknown kind ${probeKind}`);
      }

      const expected = new Set(probe.expected ?? []);
      const forbidden = new Set(probe.forbidden ?? []);
      for (const id of expected) {
        if (!localEventIds.has(id)) {
          add(findings, 'error', 'probe-expected-missing', `${fullProbeId} expects unknown event ${id}`);
        }
      }
      for (const id of forbidden) {
        if (!localEventIds.has(id)) {
          add(findings, 'error', 'probe-forbidden-missing', `${fullProbeId} forbids unknown event ${id}`);
        }
        if (expected.has(id)) {
          add(findings, 'error', 'probe-expected-forbidden-overlap', `${fullProbeId} both expects and forbids ${id}`);
        }
      }

      if (probeKind === 'capability') {
        if ((probe.requires ?? []).length === 0) {
          add(findings, 'error', 'capability-probe-requires-missing', `${fullProbeId} is a capability probe but has no requires list`);
        }
      } else if (probeKind === 'abstention') {
        if (forbidden.size === 0) {
          add(findings, strict ? 'error' : 'warn', 'abstention-no-forbidden-set', `${fullProbeId} is an abstention probe but has no forbidden set; nothing tempts a wrong answer`);
        }
        if (probe.abstainThreshold !== undefined && (probe.abstainThreshold <= 0 || probe.abstainThreshold > 1)) {
          add(findings, 'error', 'abstention-threshold-range', `${fullProbeId} abstainThreshold must be in (0, 1]`);
        }
      } else {
        if ((probe.answerKeywords ?? []).length === 0) {
          add(findings, strict ? 'error' : 'warn', 'probe-answer-keywords-missing', `${fullProbeId} has no answerKeywords`);
        }
        if ((probe.topK ?? 5) < expected.size) {
          add(findings, 'warn', 'probe-topk-too-small', `${fullProbeId} topK is smaller than expected set size`);
        }
        if (queryLeaksExpectedId(probe.query, expected)) {
          add(findings, 'warn', 'probe-query-id-leak', `${fullProbeId} query appears to leak an expected event id`);
        }
        if (expected.size > 0 && forbidden.size === 0) {
          add(findings, 'warn', 'probe-no-forbidden-set', `${fullProbeId} has no forbidden set; contamination is under-tested`);
        }
        if (expected.size === 0) {
          add(findings, 'error', 'recall-probe-no-expected', `${fullProbeId} is a recall probe but has no expected set`);
        }
      }
    }
  }

  if (dimensions.size < 3) {
    add(findings, strict ? 'error' : 'warn', 'suite-dimension-coverage-thin', 'Scenario pack should cover at least three dimensions');
  }

  const errors = findings.filter((finding) => finding.severity === 'error');
  const warnings = findings.filter((finding) => finding.severity === 'warn');
  return {
    passed: errors.length === 0,
    errorCount: errors.length,
    warningCount: warnings.length,
    findings,
    coverage: {
      scenarios: scenarioPack.scenarios?.length ?? 0,
      events: (scenarioPack.scenarios ?? []).reduce((sum, scenario) => sum + (scenario.events?.length ?? 0), 0),
      probes: (scenarioPack.scenarios ?? []).reduce((sum, scenario) => sum + (scenario.probes?.length ?? 0), 0),
      dimensions: [...dimensions.entries()].sort((left, right) => right[1] - left[1]).map(([name, count]) => ({ name, count }))
    }
  };
}

function add(findings, severity, code, message) {
  findings.push({ severity, code, message });
}

function queryLeaksExpectedId(query, expectedIds) {
  const tokens = tokenSet(query);
  for (const id of expectedIds) {
    const idTokens = tokenSet(String(id).replace(/[-_]/g, ' '));
    let matched = 0;
    for (const token of idTokens) {
      if (tokens.has(token)) {
        matched += 1;
      }
    }
    if (idTokens.size > 0 && matched === idTokens.size) {
      return true;
    }
  }
  return false;
}

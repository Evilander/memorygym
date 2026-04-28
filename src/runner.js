import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createAdapter, listAdapters } from './adapters/baselines.js';
import { AudreyHttpAdapter } from './adapters/audrey-http.js';
import { AudreyMcpAdapter } from './adapters/audrey-mcp.js';
import { scoreProbe } from './score.js';
import { percentile, stableJson } from './text.js';

export async function loadScenarioPack(path) {
  const absolutePath = resolve(path);
  const raw = await readFile(absolutePath, 'utf8');
  const parsed = JSON.parse(raw);
  validateScenarioPack(parsed, absolutePath);
  return parsed;
}

export async function runBenchmark({
  scenarioPack,
  adapters = listAdapters(),
  includeAudrey = false,
  includeAudreyHttp = false,
  outputPath,
  check = false,
  runId = createRunId(),
  audrey = {}
}) {
  const adapterNames = includeAudrey && !adapters.includes('audrey-mcp')
    ? [...adapters, 'audrey-mcp']
    : adapters;
  const fullAdapterNames = includeAudreyHttp && !adapterNames.includes('audrey-http')
    ? [...adapterNames, 'audrey-http']
    : adapterNames;

  const results = [];
  for (const adapterName of fullAdapterNames) {
    const adapter = await createBenchmarkAdapter(adapterName, { runId, audrey });
    try {
      results.push(await runAdapterScenarioPack(adapter, scenarioPack));
    } finally {
      await adapter.close?.();
    }
  }

  const report = {
    runId,
    generatedAt: new Date().toISOString(),
    suite: {
      name: scenarioPack.name,
      version: scenarioPack.version,
      scenarioCount: scenarioPack.scenarios.length,
      probeKindCounts: countProbeKinds(scenarioPack),
      fingerprint: stableJson(scenarioPack)
    },
    adapters: results,
    summary: summarizeRun(results),
    gate: evaluateGate(results, scenarioPack.gates, check)
  };

  if (outputPath) {
    await mkdir(dirname(resolve(outputPath)), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }

  return report;
}

async function runAdapterScenarioPack(adapter, scenarioPack) {
  await adapter.reset?.();
  const scenarioResults = [];

  for (const scenario of scenarioPack.scenarios) {
    scenarioResults.push(await runScenario(adapter, scenario));
  }

  return {
    name: adapter.name,
    kind: adapter.kind ?? 'local',
    scenarios: scenarioResults,
    aggregate: summarizeScenarios(scenarioResults)
  };
}

export async function runScenario(adapter, scenario) {
  await adapter.reset?.(scenario);

  const observeLatencies = [];
  const observeFailures = [];
  let consecutiveObserveFailures = 0;
  let aborted = false;
  for (const event of scenario.events) {
    const start = performance.now();
    try {
      await adapter.observe(normalizeEvent(event, scenario));
      observeLatencies.push(performance.now() - start);
      consecutiveObserveFailures = 0;
    } catch (error) {
      consecutiveObserveFailures += 1;
      const failure = {
        eventId: event.id,
        error: String(error?.message ?? error),
        at: new Date().toISOString()
      };
      observeFailures.push(failure);
      console.warn(`[memorygym] observe failed for ${scenario.id}/${event.id}: ${failure.error}`);
      if (consecutiveObserveFailures >= 3) {
        aborted = true;
        break;
      }
    }
  }

  if (aborted) {
    const probes = scenario.probes.map((probe) => abortedProbeResult(probe, 'scenario aborted after 3 consecutive observe failures'));
    return {
      id: scenario.id,
      title: scenario.title,
      dimensions: scenario.dimensions ?? [],
      eventCount: scenario.events.length,
      probeCount: scenario.probes.length,
      skippedCount: 0,
      aborted: true,
      observeFailures,
      observeLatencyMs: latencySummary(observeLatencies),
      recallLatencyMs: latencySummary([]),
      score: 0,
      probes
    };
  }

  const adapterCapabilities = await resolveAdapterCapabilities(adapter);
  const probes = [];
  for (const probe of scenario.probes) {
    const missingCapabilities = findMissingCapabilities(probe.requires, adapterCapabilities);
    if (missingCapabilities.length > 0) {
      probes.push(skippedProbeResult(probe, missingCapabilities));
      continue;
    }

    if ((probe.kind ?? 'recall') === 'capability') {
      if (typeof adapter.runCapabilityProbe !== 'function') {
        probes.push(skippedProbeResult(probe, [], 'adapter declares required capabilities but cannot execute capability probes'));
        continue;
      }
      const start = performance.now();
      let diagnostics;
      try {
        diagnostics = await adapter.runCapabilityProbe(probe, { scenario, capabilities: adapterCapabilities });
        if (containsErrorPayload(diagnostics)) {
          throw new Error('capability returned an error payload');
        }
      } catch (error) {
        probes.push(failedCapabilityProbeResult(probe, performance.now() - start, error));
        continue;
      }
      probes.push({
        id: probe.id,
        kind: 'capability',
        query: probe.query,
        requires: probe.requires ?? [],
        latencyMs: performance.now() - start,
        scoring: capabilityScoring(probe),
        recalls: [],
        diagnostics
      });
      continue;
    }

    const nativeDiagnostics = await adapter.prepareProbe?.(probe, { scenario, capabilities: adapterCapabilities });
    const start = performance.now();
    const recalls = await adapter.recall(probe.query, {
      limit: probe.topK ?? 5,
      type: probe.type,
      tags: probe.tags,
      context: probe.context
    });
    const latencyMs = performance.now() - start;
    const scoring = scoreProbe(probe, recalls, { topK: probe.topK ?? 5 });
    probes.push({
      id: probe.id,
      kind: probe.kind ?? 'recall',
      query: probe.query,
      requires: probe.requires ?? [],
      latencyMs,
      scoring,
      diagnostics: nativeDiagnostics,
      recalls: recalls.slice(0, probe.topK ?? 5).map((item) => ({
        id: item.id,
        score: Number(item.score ?? 0),
        type: item.type,
        content: item.content,
        diagnostics: item.diagnostics
      }))
    });
  }

  return {
    id: scenario.id,
    title: scenario.title,
    dimensions: scenario.dimensions ?? [],
    eventCount: scenario.events.length,
    probeCount: scenario.probes.length,
    skippedCount: probes.filter((probe) => probe.skipped).length,
    aborted: false,
    observeFailures,
    observeLatencyMs: latencySummary(observeLatencies),
    recallLatencyMs: latencySummary(probes.filter((probe) => !probe.skipped).map((probe) => probe.latencyMs)),
    score: averageOrNull(probes.filter((probe) => !probe.skipped).map((probe) => probe.scoring.score)),
    probes
  };
}

async function createBenchmarkAdapter(adapterName, options) {
  if (adapterName === 'audrey-mcp') {
    return new AudreyMcpAdapter(options.audrey ?? {}, { runId: options.runId });
  }
  if (adapterName === 'audrey-http') {
    return new AudreyHttpAdapter(options.audrey ?? {}, { runId: options.runId });
  }
  return createAdapter(adapterName);
}

function normalizeEvent(event, scenario) {
  return {
    ...event,
    tags: [...new Set([...(scenario.tags ?? []), ...(event.tags ?? [])])],
    context: {
      benchmark: scenario.id,
      ...(scenario.context ?? {}),
      ...(event.context ?? {})
    }
  };
}

function summarizeRun(adapterResults) {
  const ranked = [...adapterResults].sort((left, right) => scoreForSort(right.aggregate.score) - scoreForSort(left.aggregate.score));
  return {
    winner: Number.isFinite(ranked[0]?.aggregate.score) ? ranked[0].name : null,
    adapters: ranked.map((adapter) => ({
      name: adapter.name,
      score: adapter.aggregate.score,
      hitRate: adapter.aggregate.hitRate,
      skippedCount: adapter.aggregate.skippedCount,
      p95RecallLatencyMs: adapter.aggregate.recallLatencyMs.p95
    }))
  };
}

function summarizeScenarios(scenarios) {
  const probes = scenarios.flatMap((scenario) => scenario.probes);
  const scoredProbes = probes.filter((probe) => !probe.skipped && Number.isFinite(probe.scoring?.score));
  const scenarioScores = scenarios.map((scenario) => scenario.score).filter((score) => Number.isFinite(score));
  return {
    score: averageOrNull(scenarioScores),
    hitRate: averageOrNull(scoredProbes.map((probe) => probe.scoring.hitRate)),
    precision: averageOrNull(scoredProbes.map((probe) => probe.scoring.precision)),
    recall: averageOrNull(scoredProbes.map((probe) => probe.scoring.recall)),
    mrr: averageOrNull(scoredProbes.map((probe) => probe.scoring.mrr)),
    ndcg: averageOrNull(scoredProbes.map((probe) => probe.scoring.ndcg)),
    contaminationPenalty: averageOrNull(scoredProbes.map((probe) => probe.scoring.contaminationPenalty)),
    skippedCount: probes.length - scoredProbes.length,
    observeLatencyMs: latencySummary(scenarios.flatMap((scenario) => expandLatencySummary(scenario.observeLatencyMs))),
    recallLatencyMs: latencySummary(scoredProbes.map((probe) => probe.latencyMs))
  };
}

async function resolveAdapterCapabilities(adapter) {
  if (typeof adapter.discoverCapabilities === 'function') {
    return new Set(await adapter.discoverCapabilities());
  }
  return new Set(adapter.capabilities ?? ['memory_encode', 'memory_recall']);
}

function findMissingCapabilities(required = [], capabilities) {
  return (required ?? []).filter((capability) => !capabilities.has(capability));
}

function skippedProbeResult(probe, missingCapabilities, explicitReason) {
  return {
    id: probe.id,
    kind: probe.kind ?? 'recall',
    query: probe.query,
    requires: probe.requires ?? [],
    skipped: true,
    skipReason: explicitReason ?? `adapter does not provide capability: ${missingCapabilities.join(', ')}`,
    latencyMs: 0,
    scoring: {
      kind: probe.kind ?? 'recall',
      skipped: true,
      score: null,
      hitRate: null,
      precision: null,
      recall: null,
      mrr: null,
      ndcg: null,
      answerQuality: null,
      contaminationPenalty: null,
      matched: [],
      forbidden: [],
      returned: []
    },
    recalls: []
  };
}

function abortedProbeResult(probe, reason) {
  return {
    id: probe.id,
    kind: probe.kind ?? 'recall',
    query: probe.query,
    requires: probe.requires ?? [],
    aborted: true,
    error: reason,
    latencyMs: 0,
    scoring: failedScoring(probe.kind ?? 'recall', reason),
    recalls: []
  };
}

function failedCapabilityProbeResult(probe, latencyMs, error) {
  const message = String(error?.message ?? error);
  return {
    id: probe.id,
    kind: 'capability',
    query: probe.query,
    requires: probe.requires ?? [],
    latencyMs,
    error: message,
    scoring: failedScoring('capability', message),
    recalls: []
  };
}

function capabilityScoring(probe) {
  return {
    kind: 'capability',
    score: 1,
    hitRate: 1,
    precision: 1,
    recall: 1,
    mrr: 1,
    ndcg: 1,
    answerQuality: 1,
    contaminationPenalty: 0,
    matched: probe.requires ?? [],
    forbidden: [],
    returned: probe.requires ?? []
  };
}

function failedScoring(kind, reason) {
  return {
    kind,
    score: 0,
    hitRate: 0,
    precision: 0,
    recall: 0,
    mrr: 0,
    ndcg: 0,
    answerQuality: 0,
    contaminationPenalty: 0,
    matched: [],
    forbidden: [],
    returned: [],
    error: reason
  };
}

function containsErrorPayload(value) {
  if (!value) {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some(containsErrorPayload);
  }
  if (typeof value !== 'object') {
    return false;
  }
  if (value.isError === true || value.error || value.status === 'error') {
    return true;
  }
  return Object.values(value).some((item) => item && typeof item === 'object' && containsErrorPayload(item));
}

function evaluateGate(results, gates = {}, check) {
  if (!check) {
    return { enabled: false, passed: null, failures: [] };
  }

  const failures = [];
  for (const result of results) {
    const adapterGate = gates.adapters?.[result.name] ?? (gates.adapters ? null : gates);
    if (!adapterGate) {
      continue;
    }
    if (adapterGate.minScore !== undefined && (!Number.isFinite(result.aggregate.score) || result.aggregate.score < adapterGate.minScore)) {
      failures.push(`${result.name} score ${formatNumber(result.aggregate.score)} below ${adapterGate.minScore}`);
    }
    if (adapterGate.minHitRate !== undefined && (!Number.isFinite(result.aggregate.hitRate) || result.aggregate.hitRate < adapterGate.minHitRate)) {
      failures.push(`${result.name} hit rate ${formatNumber(result.aggregate.hitRate)} below ${adapterGate.minHitRate}`);
    }
    const maxP95 = adapterGate.maxP95RecallLatencyMs ?? gates.maxP95RecallLatencyMs;
    if (maxP95 !== undefined && result.aggregate.recallLatencyMs.p95 > maxP95) {
      failures.push(`${result.name} p95 recall latency ${result.aggregate.recallLatencyMs.p95.toFixed(1)}ms above ${maxP95}ms`);
    }
  }

  return { enabled: true, passed: failures.length === 0, failures };
}

function validateScenarioPack(pack, path) {
  if (!pack || typeof pack !== 'object') {
    throw new Error(`Scenario pack ${path} must be an object`);
  }
  if (!Array.isArray(pack.scenarios) || pack.scenarios.length === 0) {
    throw new Error(`Scenario pack ${path} must contain scenarios`);
  }
  for (const scenario of pack.scenarios) {
    if (!scenario.id || !scenario.title) {
      throw new Error(`Scenario in ${path} is missing id/title`);
    }
    if (!Array.isArray(scenario.events) || scenario.events.length === 0) {
      throw new Error(`Scenario ${scenario.id} must contain events`);
    }
    if (!Array.isArray(scenario.probes) || scenario.probes.length === 0) {
      throw new Error(`Scenario ${scenario.id} must contain probes`);
    }
    for (const event of scenario.events) {
      if (!event.id || !event.content) {
        throw new Error(`Scenario ${scenario.id} has an event missing id/content`);
      }
    }
    for (const probe of scenario.probes) {
      if (!probe.id || !probe.query || !Array.isArray(probe.expected)) {
        throw new Error(`Scenario ${scenario.id} has a probe missing id/query/expected`);
      }
    }
  }
}

function average(values) {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length === 0) {
    return 0;
  }
  return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

function averageOrNull(values) {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length === 0) {
    return null;
  }
  return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

function latencySummary(values) {
  const finite = values.filter((value) => Number.isFinite(value));
  return {
    avg: average(finite),
    p50: percentile(finite, 50),
    p95: percentile(finite, 95),
    max: finite.length === 0 ? 0 : Math.max(...finite)
  };
}

function expandLatencySummary(summary) {
  if (!summary) {
    return [];
  }
  return [summary.avg, summary.p50, summary.p95, summary.max].filter((value) => Number.isFinite(value));
}

function createRunId() {
  return `mg-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}-${randomSuffix()}`;
}

function countProbeKinds(scenarioPack) {
  const counts = {};
  for (const scenario of scenarioPack.scenarios ?? []) {
    for (const probe of scenario.probes ?? []) {
      const kind = probe.kind ?? 'recall';
      counts[kind] = (counts[kind] ?? 0) + 1;
    }
  }
  return counts;
}

function scoreForSort(value) {
  return Number.isFinite(value) ? value : -Infinity;
}

function formatNumber(value) {
  return Number.isFinite(value) ? value.toFixed(3) : 'n/a';
}

function randomSuffix() {
  return randomBytes(4).toString('hex');
}

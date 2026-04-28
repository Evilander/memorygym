import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function loadReport(path) {
  const absolutePath = resolve(path);
  const raw = await readFile(absolutePath, 'utf8');
  const report = JSON.parse(raw);
  if (!report?.adapters || !Array.isArray(report.adapters)) {
    throw new Error(`Report ${absolutePath} does not look like a MemoryGym report`);
  }
  return report;
}

export function compareReports(baseline, candidate, options = {}) {
  const minScoreDelta = Number(options.minScoreDelta ?? -0.02);
  const maxLatencyRegressionRatio = Number(options.maxLatencyRegressionRatio ?? 1.5);
  const baselineAdapters = new Map(baseline.adapters.map((adapter) => [adapter.name, adapter]));
  const candidateAdapters = new Map(candidate.adapters.map((adapter) => [adapter.name, adapter]));
  const adapters = [];
  const failures = [];

  for (const [name, candidateAdapter] of candidateAdapters.entries()) {
    const baselineAdapter = baselineAdapters.get(name);
    if (!baselineAdapter) {
      adapters.push({ name, status: 'new', scoreDelta: candidateAdapter.aggregate.score, latencyRatio: null });
      continue;
    }
    const scoreDelta = candidateAdapter.aggregate.score - baselineAdapter.aggregate.score;
    const hitRateDelta = candidateAdapter.aggregate.hitRate - baselineAdapter.aggregate.hitRate;
    const baselineP95 = baselineAdapter.aggregate.recallLatencyMs.p95 || 0.0001;
    const latencyRatio = candidateAdapter.aggregate.recallLatencyMs.p95 / baselineP95;
    const status = scoreDelta < minScoreDelta || latencyRatio > maxLatencyRegressionRatio ? 'regressed' : 'ok';

    if (scoreDelta < minScoreDelta) {
      failures.push(`${name} score delta ${scoreDelta.toFixed(3)} below ${minScoreDelta}`);
    }
    if (latencyRatio > maxLatencyRegressionRatio) {
      failures.push(`${name} p95 latency ratio ${latencyRatio.toFixed(2)} above ${maxLatencyRegressionRatio}`);
    }

    adapters.push({
      name,
      status,
      scoreDelta,
      hitRateDelta,
      latencyRatio,
      baselineScore: baselineAdapter.aggregate.score,
      candidateScore: candidateAdapter.aggregate.score,
      baselineP95RecallLatencyMs: baselineAdapter.aggregate.recallLatencyMs.p95,
      candidateP95RecallLatencyMs: candidateAdapter.aggregate.recallLatencyMs.p95
    });
  }

  for (const name of baselineAdapters.keys()) {
    if (!candidateAdapters.has(name)) {
      failures.push(`${name} missing from candidate report`);
      adapters.push({ name, status: 'missing', scoreDelta: null, latencyRatio: null });
    }
  }

  return {
    baselineRunId: baseline.runId,
    candidateRunId: candidate.runId,
    suite: candidate.suite?.name ?? baseline.suite?.name,
    passed: failures.length === 0,
    failures,
    adapters: adapters.sort((left, right) => String(left.name).localeCompare(String(right.name)))
  };
}

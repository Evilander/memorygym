import { runMatrix } from './matrix.js';
import { percentile } from './text.js';

export async function calibrateMatrix({
  suitePaths,
  adapters,
  runs = 3,
  includeAudrey = false,
  includeAudreyHttp = false,
  audrey = {}
}) {
  const samples = [];
  for (let index = 0; index < runs; index += 1) {
    samples.push(await runMatrix({
      suitePaths,
      adapters,
      check: true,
      includeAudrey,
      includeAudreyHttp,
      audrey
    }));
  }

  const byAdapter = new Map();
  for (const sample of samples) {
    for (const adapter of sample.adapters) {
      const row = byAdapter.get(adapter.name) ?? { name: adapter.name, scores: [], latencies: [] };
      row.scores.push(adapter.meanScore);
      row.latencies.push(adapter.p95RecallLatencyMs);
      byAdapter.set(adapter.name, row);
    }
  }

  const adaptersOut = [...byAdapter.values()].map((row) => ({
    name: row.name,
    runs: row.scores.length,
    meanScore: mean(row.scores),
    minScore: Math.min(...row.scores),
    maxScore: Math.max(...row.scores),
    scoreStdDev: stddev(row.scores),
    p95RecallLatencyMs: percentile(row.latencies, 95)
  })).sort((left, right) => right.meanScore - left.meanScore);

  return {
    generatedAt: new Date().toISOString(),
    runs,
    suitePaths,
    adapters: adaptersOut,
    stable: adaptersOut.every((adapter) => adapter.scoreStdDev <= 0.01),
    gate: {
      passed: samples.every((sample) => sample.gate.passed),
      failures: samples.flatMap((sample) => sample.gate.failures)
    }
  };
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

function stddev(values) {
  const avg = mean(values);
  const variance = mean(values.map((value) => (value - avg) ** 2));
  return Math.sqrt(variance);
}

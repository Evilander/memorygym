import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { loadScenarioPack, runBenchmark } from './runner.js';
import { percentile } from './text.js';

export async function runMatrix({
  suitePaths,
  adapters,
  check = true,
  outputPath,
  includeAudrey = false,
  includeAudreyHttp = false,
  audrey = {}
}) {
  const matrixRunId = createMatrixRunId();
  const suiteReports = [];

  for (const suitePath of suitePaths) {
    const scenarioPack = await loadScenarioPack(suitePath);
    const report = await runBenchmark({
      scenarioPack,
      adapters,
      includeAudrey,
      includeAudreyHttp,
      check,
      runId: `${matrixRunId}-${slugify(scenarioPack.name)}`,
      audrey
    });
    suiteReports.push({ suitePath: resolve(suitePath), report });
  }

  const matrix = {
    matrixRunId,
    generatedAt: new Date().toISOString(),
    suites: suiteReports.map(({ suitePath, report }) => ({
      suitePath,
      runId: report.runId,
      name: report.suite.name,
      version: report.suite.version,
      probeKindCounts: report.suite.probeKindCounts ?? {},
      gate: report.gate,
      summary: report.summary,
      adapters: report.adapters.map((adapter) => ({
        name: adapter.name,
        score: adapter.aggregate.score,
        hitRate: adapter.aggregate.hitRate,
        precision: adapter.aggregate.precision,
        recall: adapter.aggregate.recall,
        p95RecallLatencyMs: adapter.aggregate.recallLatencyMs.p95,
        skippedCount: adapter.aggregate.skippedCount,
        skippedProbes: adapter.scenarios.flatMap((scenario) => scenario.probes
          .filter((probe) => probe.skipped)
          .map((probe) => ({
            scenarioId: scenario.id,
            probeId: probe.id,
            kind: probe.kind,
            requires: probe.requires ?? [],
            skipReason: probe.skipReason
          })))
      }))
    })),
    adapters: summarizeAdapters(suiteReports),
    gate: summarizeMatrixGate(suiteReports)
  };

  if (outputPath) {
    await mkdir(dirname(resolve(outputPath)), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(matrix, null, 2)}\n`, 'utf8');
  }

  return matrix;
}

function summarizeAdapters(suiteReports) {
  const byAdapter = new Map();
  for (const { report } of suiteReports) {
    for (const adapter of report.adapters) {
      const row = byAdapter.get(adapter.name) ?? {
        name: adapter.name,
        suiteCount: 0,
        scores: [],
        hitRates: [],
        latencies: [],
        skippedCounts: []
      };
      row.suiteCount += 1;
      if (Number.isFinite(adapter.aggregate.score)) {
        row.scores.push(adapter.aggregate.score);
      }
      if (Number.isFinite(adapter.aggregate.hitRate)) {
        row.hitRates.push(adapter.aggregate.hitRate);
      }
      row.latencies.push(adapter.aggregate.recallLatencyMs.p95);
      row.skippedCounts.push(adapter.aggregate.skippedCount ?? 0);
      byAdapter.set(adapter.name, row);
    }
  }

  return [...byAdapter.values()]
    .map((row) => ({
      name: row.name,
      suiteCount: row.suiteCount,
      meanScore: mean(row.scores),
      minScore: row.scores.length === 0 ? null : Math.min(...row.scores),
      meanHitRate: mean(row.hitRates),
      skippedCount: row.skippedCounts.reduce((sum, value) => sum + value, 0),
      maxP95RecallLatencyMs: Math.max(...row.latencies),
      p95RecallLatencyMs: percentile(row.latencies, 95)
    }))
    .sort((left, right) => scoreForSort(right.meanScore) - scoreForSort(left.meanScore) || left.name.localeCompare(right.name));
}

function summarizeMatrixGate(suiteReports) {
  const failures = [];
  for (const { report } of suiteReports) {
    if (report.gate.enabled && !report.gate.passed) {
      for (const failure of report.gate.failures) {
        failures.push(`${report.suite.name}: ${failure}`);
      }
    }
  }
  return {
    passed: failures.length === 0,
    failures
  };
}

function mean(values) {
  if (values.length === 0) {
    return null;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function slugify(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'suite';
}

function createMatrixRunId() {
  return `matrix-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}-${randomBytes(4).toString('hex')}`;
}

function scoreForSort(value) {
  return Number.isFinite(value) ? value : -Infinity;
}

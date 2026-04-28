import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { runMatrix } from './matrix.js';
import { loadScenarioPack } from './runner.js';
import { percentile, stableJson } from './text.js';

const PACKAGE_ROOT = resolve(import.meta.dirname, '..');
const PACKAGE_JSON = JSON.parse(await readFile(resolve(PACKAGE_ROOT, 'package.json'), 'utf8'));
const DEFAULT_CAPTURE_DIR = resolve('reports', 'baselines');
const PACKAGED_BASELINE_DIR = resolve(PACKAGE_ROOT, 'reports', 'baselines');

export async function captureBaselines({
  suitePaths,
  adapters,
  runs = 5,
  outputDir = DEFAULT_CAPTURE_DIR
}) {
  const report = await collectBaselineSnapshot({ suitePaths, adapters, runs });
  const resolvedOutputDir = resolve(outputDir);
  await mkdir(resolvedOutputDir, { recursive: true });

  const files = [];
  for (const baseline of report.baselines) {
    const path = join(resolvedOutputDir, baselineFileName(baseline.adapter, baseline.version));
    await writeFile(path, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
    files.push(path);
  }

  return {
    ...report,
    outputDir: resolvedOutputDir,
    files
  };
}

export async function checkBaselines({
  suitePaths,
  adapters,
  runs = 1,
  baselineDir,
  minScoreDelta = -0.02,
  minHitRateDelta = -0.05,
  maxLatencyRegressionRatio = 1.5,
  latencyFloorMs = 5
}) {
  const resolvedBaselineDir = resolveBaselineDir(baselineDir);
  const current = await collectBaselineSnapshot({ suitePaths, adapters, runs });
  const failures = [...current.gate.failures];
  const comparisons = [];

  for (const candidate of current.baselines) {
    const baselinePath = join(resolvedBaselineDir, baselineFileName(candidate.adapter, candidate.version));
    if (!existsSync(baselinePath)) {
      failures.push(`${candidate.adapter} baseline missing at ${baselinePath}`);
      comparisons.push({
        adapter: candidate.adapter,
        status: 'missing',
        baselinePath,
        candidate
      });
      continue;
    }

    const baseline = JSON.parse(await readFile(baselinePath, 'utf8'));
    const fingerprintMatches = baseline.suite_fingerprint === candidate.suite_fingerprint;
    const scoreDelta = Number.isFinite(candidate.score) && Number.isFinite(baseline.score) ? candidate.score - baseline.score : null;
    const hitRateDelta = Number.isFinite(candidate.hitRate) && Number.isFinite(baseline.hitRate) ? candidate.hitRate - baseline.hitRate : null;
    const latencyRatio = candidate.p95RecallLatencyMs / Math.max(Number(latencyFloorMs), baseline.p95RecallLatencyMs, 0.0001);
    const adapterFailures = [];

    if (!fingerprintMatches) {
      adapterFailures.push(`${candidate.adapter} suite fingerprint changed; recapture baseline`);
    }
    if (Number.isFinite(baseline.score) && !Number.isFinite(candidate.score)) {
      adapterFailures.push(`${candidate.adapter} has no scored probes; baseline score was ${baseline.score.toFixed(3)}`);
    }
    if (Number.isFinite(scoreDelta) && scoreDelta < Number(minScoreDelta)) {
      adapterFailures.push(`${candidate.adapter} score delta ${scoreDelta.toFixed(3)} below ${Number(minScoreDelta)}`);
    }
    if (Number.isFinite(baseline.hitRate) && !Number.isFinite(candidate.hitRate)) {
      adapterFailures.push(`${candidate.adapter} has no scored probes; baseline hit rate was ${baseline.hitRate.toFixed(3)}`);
    }
    if (Number.isFinite(hitRateDelta) && hitRateDelta < Number(minHitRateDelta)) {
      adapterFailures.push(`${candidate.adapter} hit rate delta ${hitRateDelta.toFixed(3)} below ${Number(minHitRateDelta)}`);
    }
    if (latencyRatio > Number(maxLatencyRegressionRatio)) {
      adapterFailures.push(`${candidate.adapter} p95 latency ratio ${latencyRatio.toFixed(2)} above ${Number(maxLatencyRegressionRatio)}`);
    }

    failures.push(...adapterFailures);
    comparisons.push({
      adapter: candidate.adapter,
      status: adapterFailures.length === 0 ? 'ok' : 'regressed',
      baselinePath,
      baseline,
      candidate,
      scoreDelta,
      hitRateDelta,
      latencyRatio,
      fingerprintMatches,
      failures: adapterFailures
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    passed: failures.length === 0,
    baselineDir: resolvedBaselineDir,
    suite_fingerprint: current.suite_fingerprint,
    runs,
    tolerances: {
      minScoreDelta: Number(minScoreDelta),
      minHitRateDelta: Number(minHitRateDelta),
      maxLatencyRegressionRatio: Number(maxLatencyRegressionRatio),
      latencyFloorMs: Number(latencyFloorMs)
    },
    failures,
    comparisons
  };
}

async function collectBaselineSnapshot({ suitePaths, adapters, runs }) {
  const suiteSet = await fingerprintSuiteSet(suitePaths);
  const samples = [];
  for (let index = 0; index < Number(runs); index += 1) {
    samples.push(await runMatrix({
      suitePaths,
      adapters,
      check: true
    }));
  }

  const byAdapter = new Map();
  for (const sample of samples) {
    for (const adapter of sample.adapters) {
      const row = byAdapter.get(adapter.name) ?? {
        adapter: adapter.name,
        scores: [],
        hitRates: [],
        p95Latencies: []
      };
      row.scores.push(adapter.meanScore);
      row.hitRates.push(adapter.meanHitRate);
      row.p95Latencies.push(adapter.p95RecallLatencyMs);
      byAdapter.set(adapter.name, row);
    }
  }

  const capturedAt = new Date().toISOString();
  const baselines = [...byAdapter.values()]
    .sort((left, right) => String(left.adapter ?? '').localeCompare(String(right.adapter ?? '')))
    .map((row) => ({
      adapter: row.adapter,
      version: PACKAGE_JSON.version,
      suite_fingerprint: suiteSet.suite_fingerprint,
      suites: suiteSet.suites,
      score: mean(row.scores),
      hitRate: mean(row.hitRates),
      p95RecallLatencyMs: percentile(row.p95Latencies, 95),
      capturedAt,
      runs: Number(runs),
      scoreStdDev: stddev(row.scores)
    }));

  return {
    generatedAt: capturedAt,
    version: PACKAGE_JSON.version,
    suite_fingerprint: suiteSet.suite_fingerprint,
    suites: suiteSet.suites,
    runs: Number(runs),
    gate: {
      passed: samples.every((sample) => sample.gate.passed),
      failures: samples.flatMap((sample) => sample.gate.failures)
    },
    baselines
  };
}

async function fingerprintSuiteSet(suitePaths) {
  const suites = [];
  for (const suitePath of suitePaths) {
    const pack = await loadScenarioPack(suitePath);
    suites.push({
      name: pack.name,
      version: pack.version,
      fingerprint: sha256(stableJson(pack))
    });
  }

  suites.sort((left, right) => String(left.name ?? '').localeCompare(String(right.name ?? '')) || String(left.version ?? '').localeCompare(String(right.version ?? '')));
  return {
    suite_fingerprint: sha256(stableJson(suites)),
    suites
  };
}

function resolveBaselineDir(baselineDir) {
  if (baselineDir) {
    return resolve(baselineDir);
  }
  if (existsSync(DEFAULT_CAPTURE_DIR)) {
    return DEFAULT_CAPTURE_DIR;
  }
  return PACKAGED_BASELINE_DIR;
}

function baselineFileName(adapter, version) {
  return `${sanitizeFilePart(adapter)}@${sanitizeFilePart(version)}.json`;
}

function sanitizeFilePart(value) {
  return String(value).replace(/[^a-zA-Z0-9_.-]+/g, '_');
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function mean(values) {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length === 0) {
    return null;
  }
  return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

function stddev(values) {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length === 0) {
    return null;
  }
  const avg = mean(finite);
  return Math.sqrt(mean(finite.map((value) => (value - avg) ** 2)));
}

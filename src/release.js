import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { checkBaselines } from './baseline.js';
import { inspectMemoryGym } from './doctor.js';
import { lintScenarioPack } from './lint.js';
import { runMatrix } from './matrix.js';
import { loadScenarioPack } from './runner.js';

export async function runReleaseGate({
  suitePaths,
  adapters,
  outputPath,
  strictLint = true,
  includeAudrey = false,
  includeAudreyHttp = false,
  audrey = {},
  baseline = {}
}) {
  const runId = createReleaseRunId();
  const doctor = await inspectMemoryGym({ audrey });
  const lint = [];
  for (const suitePath of suitePaths) {
    const scenarioPack = await loadScenarioPack(suitePath);
    lint.push({
      suitePath: resolve(suitePath),
      suite: scenarioPack.name,
      result: lintScenarioPack(scenarioPack, { strict: strictLint })
    });
  }

  const matrix = await runMatrix({
    suitePaths,
    adapters,
    check: true,
    includeAudrey,
    includeAudreyHttp,
    audrey
  });
  const baselineReport = await checkBaselines({
    suitePaths,
    adapters,
    runs: Number(baseline.runs ?? 1),
    baselineDir: baseline.baselineDir,
    minScoreDelta: baseline.minScoreDelta,
    minHitRateDelta: baseline.minHitRateDelta,
    maxLatencyRegressionRatio: baseline.maxLatencyRegressionRatio,
    latencyFloorMs: baseline.latencyFloorMs
  });

  const failures = [];
  if (doctor.audrey.configured && (!doctor.audrey.commandExists || !doctor.audrey.entrypointExists)) {
    failures.push('Audrey is configured but command or entrypoint is missing');
  }
  for (const item of lint) {
    for (const finding of item.result.findings) {
      if (finding.severity === 'error') {
        failures.push(`${item.suite}: ${finding.code}: ${finding.message}`);
      }
    }
  }
  for (const failure of matrix.gate.failures) {
    failures.push(failure);
  }
  for (const failure of baselineReport.failures) {
    failures.push(failure);
  }

  const report = {
    runId,
    generatedAt: new Date().toISOString(),
    passed: failures.length === 0,
    failures,
    doctor,
    lint,
    matrix,
    baseline: baselineReport
  };

  if (outputPath) {
    await mkdir(dirname(resolve(outputPath)), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }

  return report;
}

function createReleaseRunId() {
  return `release-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}-${randomBytes(4).toString('hex')}`;
}

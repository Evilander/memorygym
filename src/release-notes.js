import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PACKAGE_ROOT = resolve(import.meta.dirname, '..');

export function renderReleaseNotes(report) {
  const lintErrors = report.lint.reduce((sum, item) => sum + item.result.errorCount, 0);
  const lintWarnings = report.lint.reduce((sum, item) => sum + item.result.warningCount, 0);
  const baselineByAdapter = new Map(report.baseline.comparisons.map((comparison) => [comparison.adapter, comparison]));
  const abstentionSuites = report.matrix.suites
    .map((suite) => ({ name: suite.name, count: suite.probeKindCounts?.abstention ?? 0 }))
    .filter((suite) => suite.count > 0);
  const skippedCapabilities = report.matrix.suites.flatMap((suite) => suite.adapters.flatMap((adapter) => (adapter.skippedProbes ?? []).map((probe) => ({
    suite: suite.name,
    adapter: adapter.name,
    ...probe
  }))));
  const regressions = report.baseline.comparisons
    .filter((comparison) => comparison.status !== 'ok')
    .flatMap((comparison) => comparison.failures?.map((failure) => ({ adapter: comparison.adapter, failure })) ?? [{ adapter: comparison.adapter, failure: comparison.status }])
    .slice(0, 8);

  return [
    `# MemoryGym Release Notes`,
    ``,
    `Run ID: \`${report.runId}\``,
    `Generated: ${report.generatedAt}`,
    ``,
    `## What Changed`,
    ``,
    extractUnreleasedSummary(),
    ``,
    `## Gate Status`,
    ``,
    `- Overall: ${status(report.passed)}`,
    `- Lint: ${lintErrors} errors, ${lintWarnings} warnings`,
    `- Matrix: ${status(report.matrix.gate.passed)}`,
    `- Baseline: ${status(report.baseline.passed)}`,
    ``,
    `## Scores`,
    ``,
    `| Adapter | Mean Score | Min Score | Hit Rate | P95 Recall | Baseline Score Delta | Baseline Hit Delta | Baseline P95 Ratio |`,
    `| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |`,
    ...report.matrix.adapters.map((adapter) => {
      const baseline = baselineByAdapter.get(adapter.name);
      return [
        `| ${escapeCell(adapter.name)}`,
        percent(adapter.meanScore),
        percent(adapter.minScore),
        percent(adapter.meanHitRate),
        `${adapter.p95RecallLatencyMs.toFixed(1)}ms`,
        baseline?.scoreDelta === undefined ? 'n/a' : signedPercent(baseline.scoreDelta),
        baseline?.hitRateDelta === undefined ? 'n/a' : signedPercent(baseline.hitRateDelta),
        `${baseline?.latencyRatio === undefined ? 'n/a' : `${baseline.latencyRatio.toFixed(2)}x`} |`
      ].join(' | ');
    }),
    ``,
    `## Top Regressions`,
    ``,
    ...(regressions.length === 0 ? ['No baseline regressions detected.'] : regressions.map((item) => `- ${item.adapter}: ${item.failure}`)),
    ``,
    ...methodologyLines(abstentionSuites),
    ...skippedCapabilityLines(skippedCapabilities),
    `## Environment`,
    ``,
    `- Node: ${report.doctor.node}`,
    `- CWD: \`${report.doctor.cwd}\``,
    `- Audrey configured: ${report.doctor.audrey.configured ? 'yes' : 'no'}`,
    `- Audrey command: \`${report.doctor.audrey.command ?? 'n/a'}\``,
    `- Audrey entrypoint: \`${report.doctor.audrey.entrypoint ?? 'n/a'}\``,
    `- Baseline directory: \`${report.baseline.baselineDir}\``,
    ``,
    `## Baseline Fingerprint`,
    ``,
    `\`${report.baseline.suite_fingerprint}\``,
    ``
  ].join('\n');
}

function methodologyLines(abstentionSuites) {
  if (abstentionSuites.length === 0) {
    return [];
  }
  return [
    `## Methodology`,
    ``,
    `Abstention probes are included in this suite set. These probes reward adapters for declining unsupported memories and penalize high-confidence forbidden recalls.`,
    ``,
    `| Suite | Abstention Probes |`,
    `| --- | ---: |`,
    ...abstentionSuites.map((suite) => `| ${escapeCell(suite.name)} | ${suite.count} |`),
    ``
  ];
}

function skippedCapabilityLines(skippedCapabilities) {
  if (skippedCapabilities.length === 0) {
    return [];
  }
  return [
    `## Skipped Capabilities`,
    ``,
    `| Suite | Adapter | Probe | Requires | Reason |`,
    `| --- | --- | --- | --- | --- |`,
    ...skippedCapabilities.map((probe) => [
      `| ${escapeCell(probe.suite)}`,
      escapeCell(probe.adapter),
      escapeCell(`${probe.scenarioId}/${probe.probeId}`),
      escapeCell((probe.requires ?? []).join(', ')),
      `${escapeCell(probe.skipReason)} |`
    ].join(' | ')),
    ``
  ];
}

function extractUnreleasedSummary() {
  try {
    const text = readFileSync(resolve(PACKAGE_ROOT, 'CHANGELOG.md'), 'utf8');
    const block = text.match(/## \[Unreleased]\s*([\s\S]*?)(?=\n## \[|$)/)?.[1] ?? '';
    const bullet = block.match(/^- (.+)$/m)?.[1];
    return bullet ? `- ${bullet}` : '- No unreleased changelog entries found.';
  } catch {
    return '- CHANGELOG.md not available.';
  }
}

function status(value) {
  return value ? 'passed' : 'failed';
}

function percent(value) {
  if (!Number.isFinite(value)) {
    return 'n/a';
  }
  return `${(value * 100).toFixed(1)}%`;
}

function signedPercent(value) {
  if (!Number.isFinite(value)) {
    return 'n/a';
  }
  return `${value >= 0 ? '+' : ''}${percent(value)}`;
}

function escapeCell(value) {
  return String(value ?? '').replace(/\|/g, '\\|');
}

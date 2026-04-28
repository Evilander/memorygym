#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { styleText } from 'node:util';
import {
  buildScenarioManifest,
  calibrateMatrix,
  compareReports,
  captureBaselines,
  checkBaselines,
  inspectMemoryGym,
  listAdapters,
  loadReport,
  loadScenarioPack,
  lintScenarioPack,
  renderReleaseNotes,
  runMatrix,
  runBenchmark,
  runReleaseGate,
  writeHtmlReport
} from './index.js';

const PACKAGE_ROOT = resolve(import.meta.dirname, '..');
const PACKAGE_JSON = JSON.parse(await readFile(resolve(PACKAGE_ROOT, 'package.json'), 'utf8'));
const DEFAULT_SUITE = resolve(PACKAGE_ROOT, 'benchmarks/core.scenarios.json');
const HELP_HINT = "Run 'memorygym --help' for usage.";
const BOOLEAN_FLAGS = new Set([
  'allowArbitraryAudreyCommand',
  'allowLiveAudreyData',
  'allowRemoteAudrey',
  'audrey',
  'audreyHttp',
  'audreyIsolateScenarios',
  'check',
  'help',
  'strict',
  'version'
]);

class CliUsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CliUsageError';
    this.showHelpHint = true;
  }
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const command = args._[0] ?? 'help';

  if (args.version || command === 'version') {
    console.log(PACKAGE_JSON.version);
    return;
  }

  if (command === 'help') {
    printHelp(args._[1]);
    return;
  }

  if (args.help) {
    printHelp(command === 'baseline' && args._[1] ? `baseline ${args._[1]}` : command);
    return;
  }

  if (command === 'list') {
    console.log([...listAdapters(), 'audrey-mcp', 'audrey-http'].join('\n'));
    return;
  }

  if (command === 'doctor') {
    const report = await inspectMemoryGym({
      audrey: {
        configPath: args.audreyConfig,
        dataDir: args.audreyDataDir,
        allowLiveData: Boolean(args.allowLiveAudreyData)
      }
    });
    console.log(JSON.stringify(report, null, 2));
    if (report.audrey.configured && (!report.audrey.commandExists || !report.audrey.entrypointExists)) {
      process.exitCode = 1;
    }
    return;
  }

  if (command === 'manifest') {
    const scenarioPack = await loadScenarioPack(args.suite ?? DEFAULT_SUITE);
    console.log(JSON.stringify(buildScenarioManifest(scenarioPack), null, 2));
    return;
  }

  if (command === 'lint') {
    const suitePaths = parseSuitePaths(args);
    let failed = false;
    for (const suitePath of suitePaths) {
      const scenarioPack = await loadScenarioPack(suitePath);
      const result = lintScenarioPack(scenarioPack, { strict: Boolean(args.strict) });
      printLintResult(suitePath, scenarioPack.name, result);
      failed ||= !result.passed;
    }
    if (failed) {
      process.exitCode = 1;
    }
    return;
  }

  if (command === 'matrix') {
    const outputPath = args.output ?? defaultArtifactPath('matrix', 'json');
    const matrix = await runMatrix({
      suitePaths: parseSuitePaths(args),
      adapters: parseList(args.adapters) ?? ['typed-semantic', 'hybrid'],
      check: Boolean(args.check),
      outputPath,
      includeAudrey: Boolean(args.audrey),
      includeAudreyHttp: Boolean(args.audreyHttp),
      audrey: buildAudreyOptions(args)
    });
    printMatrixSummary(matrix, outputPath);
    if (!matrix.gate.passed) {
      process.exitCode = 1;
    }
    return;
  }

  if (command === 'calibrate') {
    const report = await calibrateMatrix({
      suitePaths: parseSuitePaths(args),
      adapters: parseList(args.adapters) ?? ['typed-semantic', 'hybrid'],
      runs: Number(args.runs ?? 3),
      includeAudrey: Boolean(args.audrey),
      includeAudreyHttp: Boolean(args.audreyHttp),
      audrey: buildAudreyOptions(args)
    });
    const outputPath = args.output ?? defaultArtifactPath('calibration', 'json');
    await writeJson(outputPath, report);
    printCalibrationSummary(report, outputPath);
    if (!report.gate.passed || !report.stable) {
      process.exitCode = 1;
    }
    return;
  }

  if (command === 'baseline') {
    const action = args._[1] ?? 'help';
    if (action === 'help') {
      printHelp('baseline');
      return;
    }
    if (action === 'capture') {
      const report = await captureBaselines({
        suitePaths: parseSuitePaths(args),
        adapters: parseList(args.adapters) ?? ['typed-semantic', 'hybrid'],
        runs: Number(args.runs ?? 5),
        outputDir: args.baselineDir
      });
      printBaselineCaptureSummary(report);
      if (!report.gate.passed) {
        process.exitCode = 1;
      }
      return;
    }
    if (action === 'check') {
      const report = await checkBaselines({
        suitePaths: parseSuitePaths(args),
        adapters: parseList(args.adapters) ?? ['typed-semantic', 'hybrid'],
        runs: Number(args.runs ?? 1),
        baselineDir: args.baselineDir,
        minScoreDelta: args.minScoreDelta,
        minHitRateDelta: args.minHitRateDelta,
        maxLatencyRegressionRatio: args.maxLatencyRegressionRatio,
        latencyFloorMs: args.latencyFloorMs
      });
      printBaselineCheckSummary(report);
      if (!report.passed) {
        process.exitCode = 1;
      }
      return;
    }
    throw new CliUsageError(`Unknown baseline action: ${action}`);
  }

  if (command === 'release') {
    const outputPath = args.output ?? defaultArtifactPath('release-gate', 'json');
    const report = await runReleaseGate({
      suitePaths: parseSuitePaths(args),
      adapters: parseList(args.adapters) ?? ['typed-semantic', 'hybrid'],
      outputPath,
      strictLint: args.strict === undefined ? true : Boolean(args.strict),
      includeAudrey: Boolean(args.audrey),
      includeAudreyHttp: Boolean(args.audreyHttp),
      audrey: buildAudreyOptions(args),
      baseline: buildBaselineOptions(args)
    });
    const notesPaths = await writeReleaseNotesArtifactsSafely(report, args.notes);
    printReleaseSummary(report, outputPath, notesPaths);
    if (!report.passed) {
      process.exitCode = 1;
    }
    return;
  }

  if (command === 'compare') {
    if (!args.baseline || !args.candidate) {
      throw new Error('compare requires --baseline and --candidate');
    }
    const baseline = await loadReport(args.baseline);
    const candidate = await loadReport(args.candidate);
    const comparison = compareReports(baseline, candidate, {
      minScoreDelta: args.minScoreDelta,
      maxLatencyRegressionRatio: args.maxLatencyRegressionRatio
    });
    printComparison(comparison);
    if (!comparison.passed) {
      process.exitCode = 1;
    }
    return;
  }

  if (command === 'run') {
    const suitePath = args.suite ?? DEFAULT_SUITE;
    const scenarioPack = await loadScenarioPack(suitePath);
    const adapters = parseList(args.adapters) ?? listAdapters();
    const outputPath = args.output ?? defaultJsonReportPath(scenarioPack.name);
    const htmlPath = args.html ?? outputPath.replace(/\.json$/i, '.html');

    const report = await runBenchmark({
      scenarioPack,
      adapters,
      includeAudrey: Boolean(args.audrey),
      includeAudreyHttp: Boolean(args.audreyHttp),
      outputPath,
      check: Boolean(args.check),
      audrey: buildAudreyOptions(args)
    });

    await writeHtmlReport(report, htmlPath);
    printRunSummary(report, outputPath, htmlPath);

    if (report.gate.enabled && !report.gate.passed) {
      process.exitCode = 1;
    }
    return;
  }

  throw new CliUsageError(`Unknown command: ${command}`);
}

function parseArgs(argv) {
  const parsed = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '-h') {
      parsed.help = true;
      continue;
    }
    if (arg === '-v') {
      parsed.version = true;
      continue;
    }
    if (!arg.startsWith('--')) {
      parsed._.push(arg);
      continue;
    }
    const [rawKey, inlineValue] = arg.slice(2).split('=', 2);
    const key = toCamelCase(rawKey);
    const next = argv[index + 1];
    if (inlineValue !== undefined) {
      parsed[key] = inlineValue;
    } else if (BOOLEAN_FLAGS.has(key) || !next) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      index += 1;
    }
  }
  return parsed;
}

function parseList(value) {
  if (!value) {
    return null;
  }
  return String(value).split(',').map((item) => item.trim()).filter(Boolean);
}

function parseSuitePaths(args) {
  return parseList(args.suites ?? args.suite) ?? [DEFAULT_SUITE];
}

function buildAudreyOptions(args) {
  return {
    configPath: args.audreyConfig,
    dataDir: args.audreyDataDir,
    allowLiveData: Boolean(args.allowLiveAudreyData),
    baseUrl: args.audreyHttpBaseUrl,
    port: args.audreyPort,
    apiKey: args.audreyApiKey,
    embeddingProvider: args.audreyEmbeddingProvider,
    llmProvider: args.audreyLlmProvider,
    device: args.audreyDevice,
    allowRemoteAudrey: Boolean(args.allowRemoteAudrey),
    allowArbitraryCommand: Boolean(args.allowArbitraryAudreyCommand),
    persistentChild: !args.audreyIsolateScenarios
  };
}

function buildBaselineOptions(args) {
  return {
    baselineDir: args.baselineDir,
    runs: Number(args.baselineRuns ?? 1),
    minScoreDelta: args.minScoreDelta,
    minHitRateDelta: args.minHitRateDelta,
    maxLatencyRegressionRatio: args.maxLatencyRegressionRatio,
    latencyFloorMs: args.latencyFloorMs
  };
}

function toCamelCase(value) {
  return value.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}

function statusText(passed) {
  return color(passed ? 'passed' : 'failed', passed ? 'green' : 'red');
}

function yesNoText(value) {
  return color(value ? 'yes' : 'no', value ? 'green' : 'red');
}

function color(text, format) {
  if (process.env.NO_COLOR) {
    return text;
  }
  return styleText(format, text);
}

function defaultJsonReportPath(suiteName = 'suite') {
  const slug = String(suiteName)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48) || 'suite';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const suffix = randomBytes(4).toString('hex');
  return resolve('reports', `${slug}-${stamp}-${process.pid}-${suffix}.json`);
}

function defaultArtifactPath(prefix, extension) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const suffix = randomBytes(4).toString('hex');
  return resolve('reports', `${prefix}-${stamp}-${process.pid}-${suffix}.${extension}`);
}

function defaultReleaseNotesPath(runId) {
  return resolve('reports', `release-notes-${sanitizePathPart(runId)}.md`);
}

function sanitizePathPart(value) {
  return String(value).replace(/[^a-zA-Z0-9_.-]+/g, '_').slice(0, 120) || 'release';
}

async function writeArtifact(outputPath, content) {
  const absolute = resolve(outputPath);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, content, 'utf8');
}

function writeJson(outputPath, data) {
  return writeArtifact(outputPath, `${JSON.stringify(data, null, 2)}\n`);
}

async function writeReleaseNotesArtifactsSafely(report, requestedPath) {
  try {
    const markdown = renderReleaseNotes(report);
    const autoPath = defaultReleaseNotesPath(report.runId);
    const paths = [autoPath];
    await writeArtifact(autoPath, markdown);

    if (requestedPath && resolve(requestedPath) !== resolve(autoPath)) {
      await writeArtifact(requestedPath, markdown);
      paths.push(requestedPath);
    }
    return paths;
  } catch (error) {
    console.warn(`[memorygym] release notes were not written: ${error?.message ?? error}`);
    return [];
  }
}

function formatPercent(value) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(1).padStart(5)}%` : '  n/a';
}

function printRunSummary(report, outputPath, htmlPath) {
  console.log(`MemoryGym ${report.suite.name} (${report.runId})`);
  console.log(`Winner: ${report.summary.winner ?? 'none'}`);
  for (const adapter of report.summary.adapters) {
    const score = formatPercent(adapter.score);
    const hitRate = formatPercent(adapter.hitRate);
    const p95 = adapter.p95RecallLatencyMs.toFixed(1).padStart(7);
    console.log(`${adapter.name.padEnd(16)} score=${score} hit=${hitRate} skipped=${String(adapter.skippedCount ?? 0).padStart(3)} p95=${p95}ms`);
  }
  console.log(`JSON: ${resolve(outputPath)}`);
  console.log(`HTML: ${resolve(htmlPath)}`);
  if (report.gate.enabled) {
    console.log(`Gate: ${statusText(report.gate.passed)}`);
    for (const failure of report.gate.failures) {
      console.log(`  - ${failure}`);
    }
  }
}

function printComparison(comparison) {
  console.log(`MemoryGym comparison: ${comparison.baselineRunId} -> ${comparison.candidateRunId}`);
  console.log(`Suite: ${comparison.suite ?? 'unknown'}`);
  for (const adapter of comparison.adapters) {
    const delta = adapter.scoreDelta === null ? 'n/a' : `${adapter.scoreDelta >= 0 ? '+' : ''}${(adapter.scoreDelta * 100).toFixed(1)}%`;
    const latency = adapter.latencyRatio === null ? 'n/a' : `${adapter.latencyRatio.toFixed(2)}x`;
    console.log(`${adapter.name.padEnd(16)} ${adapter.status.padEnd(9)} scoreDelta=${delta.padStart(7)} p95Ratio=${latency}`);
  }
  console.log(`Gate: ${statusText(comparison.passed)}`);
  for (const failure of comparison.failures) {
    console.log(`  - ${failure}`);
  }
}

function printLintResult(suitePath, suiteName, result) {
  console.log(`MemoryGym lint: ${suiteName} (${resolve(suitePath)})`);
  console.log(`Coverage: ${result.coverage.scenarios} scenarios, ${result.coverage.events} events, ${result.coverage.probes} probes`);
  console.log(`Findings: ${result.errorCount} errors, ${result.warningCount} warnings`);
  for (const finding of result.findings) {
    console.log(`${finding.severity.toUpperCase().padEnd(5)} ${finding.code}: ${finding.message}`);
  }
  console.log(`Gate: ${statusText(result.passed)}`);
}

function printMatrixSummary(matrix, outputPath) {
  console.log(`MemoryGym matrix (${matrix.matrixRunId})`);
  for (const adapter of matrix.adapters) {
    console.log(`${adapter.name.padEnd(16)} mean=${formatPercent(adapter.meanScore).trim()} min=${formatPercent(adapter.minScore).trim()} hit=${formatPercent(adapter.meanHitRate).trim()} skipped=${adapter.skippedCount ?? 0} p95=${adapter.p95RecallLatencyMs.toFixed(1)}ms`);
  }
  console.log(`JSON: ${resolve(outputPath)}`);
  console.log(`Gate: ${statusText(matrix.gate.passed)}`);
  for (const failure of matrix.gate.failures) {
    console.log(`  - ${failure}`);
  }
}

function printCalibrationSummary(report, outputPath) {
  console.log(`MemoryGym calibration (${report.runs} runs)`);
  for (const adapter of report.adapters) {
    console.log(`${adapter.name.padEnd(16)} mean=${(adapter.meanScore * 100).toFixed(1)}% std=${(adapter.scoreStdDev * 100).toFixed(2)}% min=${(adapter.minScore * 100).toFixed(1)}% max=${(adapter.maxScore * 100).toFixed(1)}%`);
  }
  console.log(`Stable: ${yesNoText(report.stable)}`);
  console.log(`JSON: ${resolve(outputPath)}`);
  console.log(`Gate: ${statusText(report.gate.passed)}`);
}

function printBaselineCaptureSummary(report) {
  console.log(`MemoryGym baseline capture: ${statusText(report.gate.passed)}`);
  console.log(`Suites: ${report.suites.map((suite) => `${suite.name}@${suite.version}`).join(', ')}`);
  console.log(`Runs: ${report.runs}`);
  console.log(`Output: ${resolve(report.outputDir)}`);
  for (const baseline of report.baselines) {
    const std = Number.isFinite(baseline.scoreStdDev) ? `${(baseline.scoreStdDev * 100).toFixed(2)}%` : 'n/a';
    console.log(`${baseline.adapter.padEnd(16)} score=${formatPercent(baseline.score).trim()} hit=${formatPercent(baseline.hitRate).trim()} p95=${baseline.p95RecallLatencyMs.toFixed(1)}ms std=${std}`);
  }
  for (const path of report.files) {
    console.log(`  - ${resolve(path)}`);
  }
  for (const failure of report.gate.failures) {
    console.log(`  - ${failure}`);
  }
}

function printBaselineCheckSummary(report) {
  console.log(`MemoryGym baseline check: ${statusText(report.passed)}`);
  console.log(`Baseline dir: ${resolve(report.baselineDir)}`);
  console.log(`Runs: ${report.runs}`);
  for (const comparison of report.comparisons) {
    if (comparison.status === 'missing') {
      console.log(`${comparison.adapter.padEnd(16)} missing`);
      continue;
    }
    const delta = formatSignedPercent(comparison.scoreDelta);
    const hitDelta = formatSignedPercent(comparison.hitRateDelta);
    console.log(`${comparison.adapter.padEnd(16)} ${comparison.status.padEnd(9)} scoreDelta=${delta.padStart(7)} hitDelta=${hitDelta.padStart(7)} p95Ratio=${comparison.latencyRatio.toFixed(2)}x`);
  }
  for (const failure of report.failures) {
    console.log(`  - ${failure}`);
  }
}

function formatSignedPercent(value) {
  if (!Number.isFinite(value)) {
    return 'n/a';
  }
  return `${value >= 0 ? '+' : ''}${(value * 100).toFixed(1)}%`;
}

function printReleaseSummary(report, outputPath, notesPaths = []) {
  console.log(`MemoryGym release gate: ${statusText(report.passed)}`);
  console.log(`Lint: ${report.lint.reduce((sum, item) => sum + item.result.errorCount, 0)} errors, ${report.lint.reduce((sum, item) => sum + item.result.warningCount, 0)} warnings`);
  console.log(`Matrix: ${statusText(report.matrix.gate.passed)}`);
  console.log(`Baseline: ${statusText(report.baseline.passed)}`);
  for (const adapter of report.matrix.adapters) {
    console.log(`${adapter.name.padEnd(16)} mean=${formatPercent(adapter.meanScore).trim()} min=${formatPercent(adapter.minScore).trim()}`);
  }
  console.log(`JSON: ${resolve(outputPath)}`);
  for (const notesPath of notesPaths) {
    console.log(`Notes: ${resolve(notesPath)}`);
  }
  for (const failure of report.failures) {
    console.log(`  - ${failure}`);
  }
}

function printHelp(topic) {
  if (topic) {
    const subcommandHelp = SUBCOMMAND_HELP[topic];
    if (subcommandHelp) {
      console.log(subcommandHelp);
      return;
    }
    console.log(`Unknown help topic: ${topic}`);
    console.log(HELP_HINT);
    return;
  }

  console.log(`MemoryGym ${PACKAGE_JSON.version}

Usage:
  memorygym --version
  memorygym run [--suite path] [--adapters a,b,c] [--audrey] [--check]
  memorygym compare --baseline old.json --candidate new.json
  memorygym lint --suites core.json,regression.json --strict
  memorygym matrix --suites core.json,regression.json --adapters typed-semantic,hybrid --check
  memorygym calibrate --suites core.json,regression.json --runs 3
  memorygym baseline capture --suites core.json,regression.json --adapters typed-semantic,hybrid --runs 5
  memorygym baseline check --suites core.json,regression.json --adapters typed-semantic,hybrid
  memorygym release --suites core.json,regression.json --adapters typed-semantic,hybrid
  memorygym doctor
  memorygym manifest [--suite path]
  memorygym list
  memorygym <command> --help

Examples:
  npm run bench
  npm run bench:regression
  node src/cli.js run --adapters typed-semantic,hybrid --check
  node src/cli.js run --audrey --audrey-embedding-provider mock
  node src/cli.js run --audrey-http --audrey-http-base-url http://127.0.0.1:7437
  node src/cli.js compare --baseline reports/old.json --candidate reports/new.json

Audrey runs use an isolated .memorygym/audrey-runs data directory unless --audrey-data-dir is provided. Child processes receive a small safe environment by default; set MEMORYGYM_PASS_ENV=1 only for trusted local debugging.
`);
}

const SUBCOMMAND_HELP = {
  run: `MemoryGym run

Usage:
  memorygym run [--suite path] [--adapters a,b,c] [--audrey] [--audrey-http] [--check] [--output report.json] [--html report.html] [--allow-remote-audrey]

Runs one scenario pack. If --suite is omitted, MemoryGym uses the bundled core suite from the installed package.
Audrey HTTP base URLs are restricted to localhost unless --allow-remote-audrey is supplied.
`,
  list: `MemoryGym list

Usage:
  memorygym list

Prints built-in local adapters and external adapter names.
`,
  doctor: `MemoryGym doctor

Usage:
  memorygym doctor [--audrey-config path] [--audrey-data-dir path] [--allow-live-audrey-data]

Prints local runtime and Audrey configuration diagnostics without starting Audrey.
`,
  manifest: `MemoryGym manifest

Usage:
  memorygym manifest [--suite path]

Prints suite metadata, dimensions, tags, gates, and adapter availability.
`,
  lint: `MemoryGym lint

Usage:
  memorygym lint --suites suite-a.json,suite-b.json [--strict]

Checks scenario pack quality, duplicate IDs, missing expected or forbidden references, query ID leaks, and gate coverage.
`,
  matrix: `MemoryGym matrix

Usage:
  memorygym matrix --suites suite-a.json,suite-b.json --adapters typed-semantic,hybrid [--check] [--output report.json]

Runs multiple suites and aggregates adapter scores across them.
`,
  calibrate: `MemoryGym calibrate

Usage:
  memorygym calibrate --suites suite-a.json,suite-b.json --adapters typed-semantic,hybrid [--runs 3] [--output report.json]

Repeats matrix runs to measure score stability.
`,
  release: `MemoryGym release

Usage:
  memorygym release --suites suite-a.json,suite-b.json --adapters typed-semantic,hybrid [--output report.json] [--notes notes.md] [--baseline-dir reports/baselines]

Runs diagnostics, strict suite linting, matrix gates, and baseline regression checks into JSON and markdown release artifacts.
`,
  compare: `MemoryGym compare

Usage:
  memorygym compare --baseline old.json --candidate new.json [--min-score-delta -0.02] [--max-latency-regression-ratio 1.5]

Compares two MemoryGym reports and fails on score or latency regressions.
`,
  baseline: `MemoryGym baseline

Usage:
  memorygym baseline capture --suites suite-a.json,suite-b.json --adapters typed-semantic,hybrid [--runs 5] [--baseline-dir reports/baselines]
  memorygym baseline check --suites suite-a.json,suite-b.json --adapters typed-semantic,hybrid [--runs 1] [--baseline-dir reports/baselines] [--latency-floor-ms 5]

Captures or checks aggregate-only locked baselines for the selected suite set and adapters.
`,
  'baseline capture': `MemoryGym baseline capture

Usage:
  memorygym baseline capture --suites suite-a.json,suite-b.json --adapters typed-semantic,hybrid [--runs 5] [--baseline-dir reports/baselines]

Runs the selected suites repeatedly and writes reports/baselines/<adapter>@<version>.json artifacts.
`,
  'baseline check': `MemoryGym baseline check

Usage:
  memorygym baseline check --suites suite-a.json,suite-b.json --adapters typed-semantic,hybrid [--runs 1] [--baseline-dir reports/baselines] [--latency-floor-ms 5]

Runs the selected suites and fails on score, hit-rate, latency, or suite-fingerprint regressions against locked baselines.
`
};

main().catch((error) => {
  if (process.env.MEMORYGYM_DEBUG) {
    console.error(error.stack ?? error.message);
  } else {
    console.error(error.message);
    if (error.showHelpHint) {
      console.error(HELP_HINT);
    }
  }
  process.exitCode = 1;
});

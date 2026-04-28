import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path, { join, resolve } from 'node:path';
import { compareReports } from '../src/compare.js';
import { AudreyMcpAdapter, resolveAudreyConfig, isWithinOrSamePath, resolveDataDir } from '../src/adapters/audrey-mcp.js';
import { validateAudreyHttpBaseUrl } from '../src/adapters/audrey-http.js';
import { buildChildEnv } from '../src/env.js';
import { buildScenarioManifest, calibrateMatrix, captureBaselines, checkBaselines, inspectMemoryGym, lintScenarioPack, loadScenarioPack, renderReleaseNotes, runBenchmark, runMatrix, runReleaseGate } from '../src/index.js';
import { McpStdioClient } from '../src/mcp/stdio-client.js';
import { runScenario } from '../src/runner.js';
import { scoreProbe } from '../src/score.js';

const tests = [
  ['scoreProbe rewards expected recall and penalizes forbidden recall', testScoreProbe],
  ['scoreProbe handles abstention probes with and without contamination', testAbstentionProbe],
  ['resolveAudreyConfig reads explicit Audrey MCP options', testAudreyConfig],
  ['Audrey launch configuration is hardened', testAudreyLaunchHardening],
  ['child process env is allowlisted by default', testChildEnvAllowlist],
  ['Audrey HTTP remote URLs require opt-in', testAudreyHttpUrlGuard],
  ['core scenario pack runs local benchmark adapters', testRunner],
  ['capability probes skip cleanly when adapter lacks required tools', testCapabilityProbeSkipping],
  ['capability probe execution failures score zero', testCapabilityProbeFailure],
  ['observe failures are recorded without aborting the run', testObserveFailureHandling],
  ['regression suite manifest exposes dimensions and counts', testManifest],
  ['strict suite lint passes with no findings', testLint],
  ['lint flags abstention probes that lack a forbidden set', testLintAbstentionRules],
  ['extended scenario packs pass strict lint and reasonable gates', testExtendedPacks],
  ['matrix and calibration aggregate multiple suites', testMatrixAndCalibration],
  ['baseline capture and check use aggregate-only lock files', testBaselineCaptureAndCheck],
  ['release gate combines diagnostics lint and matrix', testReleaseGate],
  ['compareReports catches score and latency regressions', testCompareReports],
  ['MCP stdout buffer is capped', testMcpStdoutBufferCap],
  ['Audrey MCP adapter persists child across scenarios by default', testAudreyMcpPersistentChild],
  ['doctor inspects Audrey config without spawning a child process', testDoctor],
  ['CLI handles version help errors and package-relative default suite', testCliFirstContact]
];

let failures = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`not ok - ${name}`);
    console.error(error.stack ?? error.message);
  }
}

if (failures > 0) {
  process.exitCode = 1;
}

async function testScoreProbe() {
  const probe = {
    expected: ['current'],
    forbidden: ['stale'],
    answerKeywords: ['Aurora'],
    topK: 2
  };

  const clean = scoreProbe(probe, [
    { id: 'current', content: 'Maya moved to Aurora.' },
    { id: 'other', content: 'Unrelated.' }
  ]);
  const contaminated = scoreProbe(probe, [
    { id: 'stale', content: 'Maya used Atlas.' },
    { id: 'current', content: 'Maya moved to Aurora.' }
  ]);

  assert.equal(clean.hitRate, 1);
  assert.equal(clean.forbidden.length, 0);
  assert.equal(contaminated.forbidden.length, 1);
  assert.ok(clean.score > contaminated.score);
}

async function testAbstentionProbe() {
  const probe = {
    kind: 'abstention',
    expected: [],
    forbidden: ['team-platform-lead', 'team-payments-lead'],
    abstainThreshold: 0.4
  };

  const lowConfidenceOnly = scoreProbe(probe, [
    { id: 'team-platform-lead', score: 0.18, content: 'Adira leads Platform.' },
    { id: 'team-payments-lead', score: 0.12, content: 'Beto leads Payments.' }
  ]);
  assert.equal(lowConfidenceOnly.kind, 'abstention');
  assert.equal(lowConfidenceOnly.abstained, true);
  assert.equal(lowConfidenceOnly.score, 1);
  assert.equal(lowConfidenceOnly.contaminationPenalty, 0);

  const confidentForbiddenLeak = scoreProbe(probe, [
    { id: 'team-platform-lead', score: 0.62, content: 'Adira leads Platform.' },
    { id: 'team-payments-lead', score: 0.55, content: 'Beto leads Payments.' }
  ]);
  assert.equal(confidentForbiddenLeak.abstained, false);
  assert.equal(confidentForbiddenLeak.highConfidenceForbiddenCount, 2);
  assert.equal(confidentForbiddenLeak.score, 0);

  const expectedConfident = scoreProbe(
    {
      ...probe,
      expected: ['expected-1'],
      forbidden: ['team-platform-lead']
    },
    [
      { id: 'expected-1', score: 0.7, content: 'Match.' },
      { id: 'team-platform-lead', score: 0.2, content: 'Adira leads Platform.' }
    ]
  );
  assert.equal(expectedConfident.score, 1);
  assert.equal(expectedConfident.hitRate, 1);

  const silentNonAbstention = scoreProbe(
    {
      ...probe,
      expected: ['expected-1'],
      forbidden: ['team-platform-lead']
    },
    []
  );
  assert.equal(silentNonAbstention.score, 0, 'silent adapter on probe with expected answer must not score 1');
  assert.equal(silentNonAbstention.hitRate, 0);
  assert.equal(silentNonAbstention.abstained, true);
}

async function testAudreyConfig() {
  const config = await resolveAudreyConfig({
    command: 'node',
    args: ['audrey.js'],
    env: {
      AUDREY_EMBEDDING_PROVIDER: 'mock'
    }
  });

  assert.equal(config.command, 'node');
  assert.deepEqual(config.args, ['audrey.js']);
  assert.equal(config.env.AUDREY_EMBEDDING_PROVIDER, 'mock');
}

async function testAudreyLaunchHardening() {
  const configPath = join(mkdtempSync(join(tmpdir(), 'memorygym-audrey-config-')), 'config.toml');
  writeFileSync(configPath, [
    '[mcp_servers.audrey-memory]',
    'command = "node"',
    'args = ["--flag=a,b", "second"]',
    '',
    '[mcp_servers.audrey-memory.env]',
    'AUDREY_TEST_VALUE = "x,y"'
  ].join('\n'), 'utf8');

  const parsed = await resolveAudreyConfig({ configPath });
  assert.deepEqual(parsed.args, ['--flag=a,b', 'second']);
  assert.equal(parsed.env.AUDREY_TEST_VALUE, 'x,y');

  await assert.rejects(
    () => resolveAudreyConfig({ command: 'not-audrey.exe', args: ['serve.js'] }),
    /Refusing to launch Audrey MCP command/
  );
  const allowed = await resolveAudreyConfig({
    command: 'not-audrey.exe',
    args: ['serve.js'],
    allowArbitraryCommand: true
  });
  assert.equal(allowed.command, 'not-audrey.exe');

  assert.equal(isWithinOrSamePath('/home/alex/.audrey/data', '/home/alex/.audrey/data', path.posix), true);
  assert.equal(isWithinOrSamePath('/home/alex/.audrey/data', '/home/alex/.audrey/data/project', path.posix), true);
  assert.equal(isWithinOrSamePath('/home/alex/.audrey/data', '/home/alex/.audrey/data-other', path.posix), false);
  assert.throws(
    () => resolveDataDir({ dataDir: join(homedir(), '.audrey', 'data') }, 'run', 'scenario', 'audrey-runs'),
    /live Audrey data dir/
  );
}

async function testChildEnvAllowlist() {
  const env = buildChildEnv(
    { EXPLICIT_SECRET: 'allowed', AUDREY_DEVICE: 'cpu' },
    {
      PATH: '/bin',
      HOME: '/home/alex',
      GITHUB_TOKEN: 'blocked',
      AWS_SECRET_ACCESS_KEY: 'blocked',
      ANTHROPIC_API_KEY: 'blocked',
      AUDREY_SAFE: 'yes',
      MEMORYGYM_SAFE: 'yes'
    }
  );

  assert.equal(env.PATH, '/bin');
  assert.equal(env.HOME, '/home/alex');
  assert.equal(env.AUDREY_SAFE, 'yes');
  assert.equal(env.MEMORYGYM_SAFE, 'yes');
  assert.equal(env.EXPLICIT_SECRET, 'allowed');
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);

  const passThrough = buildChildEnv({}, { MEMORYGYM_PASS_ENV: '1', GITHUB_TOKEN: 'allowed' });
  assert.equal(passThrough.GITHUB_TOKEN, 'allowed');
}

async function testAudreyHttpUrlGuard() {
  assert.equal(validateAudreyHttpBaseUrl('http://localhost:7437'), 'http://localhost:7437');
  assert.equal(validateAudreyHttpBaseUrl('http://127.0.0.1:7437'), 'http://127.0.0.1:7437');
  assert.equal(validateAudreyHttpBaseUrl('http://[::1]:7437'), 'http://[::1]:7437');
  assert.throws(
    () => validateAudreyHttpBaseUrl('https://attacker.example.com'),
    /Refusing remote Audrey HTTP base URL/
  );
  assert.equal(validateAudreyHttpBaseUrl('https://audrey.example.com', { allowRemoteAudrey: true }), 'https://audrey.example.com');
}

async function testRunner() {
  const scenarioPack = await loadScenarioPack('benchmarks/core.scenarios.json');
  const report = await runBenchmark({
    scenarioPack,
    adapters: ['typed-semantic', 'hybrid'],
    check: true,
    runId: 'test-local'
  });

  assert.equal(report.adapters.length, 2);
  assert.equal(report.gate.passed, true);
  assert.ok(report.summary.winner);
  for (const adapter of report.adapters) {
    assert.ok(adapter.aggregate.score > 0.5, `${adapter.name} should score above baseline`);
    assert.ok(adapter.aggregate.recallLatencyMs.p95 >= 0);
  }
}

async function testCapabilityProbeSkipping() {
  const scenarioPack = await loadScenarioPack('benchmarks/audrey-capabilities.scenarios.json');
  const lint = lintScenarioPack(scenarioPack, { strict: true });
  assert.equal(lint.passed, true, `capability lint failures: ${JSON.stringify(lint.findings)}`);
  assert.equal(lint.warningCount, 0);

  const report = await runBenchmark({
    scenarioPack,
    adapters: ['hybrid'],
    check: false,
    runId: 'test-capability-skip'
  });

  const adapter = report.adapters[0];
  assert.equal(adapter.aggregate.skippedCount, 6);
  assert.equal(adapter.aggregate.score, null);
  assert.equal(report.summary.winner, null);
  assert.equal(adapter.scenarios.flatMap((scenario) => scenario.probes).every((probe) => probe.skipped), true);
  assert.match(adapter.scenarios[0].probes[0].skipReason, /memory_resolve_truth/);
}

async function testCapabilityProbeFailure() {
  const scenario = {
    id: 'capability-failure',
    title: 'Capability failure',
    events: [{ id: 'evt-1', content: 'Event content long enough for normal validation.' }],
    probes: [
      {
        id: 'dream-fails',
        kind: 'capability',
        query: 'Run dream',
        expected: [],
        requires: ['memory_dream']
      }
    ]
  };
  const adapter = {
    name: 'failing-capability',
    capabilities: ['memory_encode', 'memory_recall', 'memory_dream'],
    async reset() {},
    async observe() {},
    async runCapabilityProbe() {
      throw new Error('native tool failed');
    }
  };

  const result = await runScenario(adapter, scenario);
  assert.equal(result.score, 0);
  assert.equal(result.probes[0].skipped, undefined);
  assert.equal(result.probes[0].scoring.score, 0);
  assert.match(result.probes[0].error, /native tool failed/);

  const noExecutor = {
    ...adapter,
    runCapabilityProbe: undefined
  };
  const skipped = await runScenario(noExecutor, scenario);
  assert.equal(skipped.score, null);
  assert.equal(skipped.probes[0].skipped, true);
  assert.match(skipped.probes[0].skipReason, /cannot execute capability probes/);
}

async function testObserveFailureHandling() {
  const scenario = {
    id: 'observe-failures',
    title: 'Observe failures',
    events: [
      { id: 'evt-1', content: 'First event content long enough for validation.' },
      { id: 'evt-2', content: 'Second event content long enough for validation.' },
      { id: 'evt-3', content: 'Third event content long enough for validation.' },
      { id: 'evt-4', content: 'Fourth event content long enough for validation.' }
    ],
    probes: [
      {
        id: 'probe-1',
        query: 'What happened?',
        expected: ['evt-1'],
        forbidden: []
      }
    ]
  };
  const adapter = {
    name: 'observe-failure',
    capabilities: ['memory_encode', 'memory_recall'],
    async reset() {},
    async observe() {
      throw new Error('transient write failure');
    },
    async recall() {
      return [];
    }
  };
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const result = await runScenario(adapter, scenario);
    assert.equal(result.aborted, true);
    assert.equal(result.observeFailures.length, 3);
    assert.equal(result.probes[0].aborted, true);
    assert.equal(result.score, 0);
  } finally {
    console.warn = originalWarn;
  }
}

async function testManifest() {
  const scenarioPack = await loadScenarioPack('benchmarks/audrey-regression.scenarios.json');
  const manifest = buildScenarioManifest(scenarioPack);
  assert.equal(manifest.scenarioCount, 5);
  assert.equal(manifest.probeCount, 7);
  assert.ok(manifest.dimensions.some((dimension) => dimension.name === 'authority'));
  assert.ok(manifest.adapters.external.includes('audrey-http'));
}

async function testLint() {
  const scenarioPack = await loadScenarioPack('benchmarks/audrey-regression.scenarios.json');
  const result = lintScenarioPack(scenarioPack, { strict: true });
  assert.equal(result.passed, true);
  assert.equal(result.findings.length, 0);
}

async function testLintAbstentionRules() {
  const pack = {
    name: 'Lint Abstention Test',
    version: '0.1.0',
    gates: { adapters: { hybrid: { minScore: 0.5, minHitRate: 0.5 } } },
    scenarios: [
      {
        id: 'abstain-no-forbidden',
        title: 'Abstention probe without forbidden set',
        dimensions: ['abstention'],
        events: [{ id: 'evt-a', type: 'semantic', content: 'A long enough event content for lint to accept it.' }],
        probes: [
          {
            id: 'unguarded-abstention',
            kind: 'abstention',
            query: 'Anything?',
            expected: [],
            forbidden: []
          }
        ]
      },
      {
        id: 'recall-no-expected',
        title: 'Recall probe with empty expected',
        dimensions: ['interference'],
        events: [{ id: 'evt-b', type: 'semantic', content: 'A long enough event content for lint to accept it.' }],
        probes: [
          {
            id: 'empty-expected',
            query: 'Anything?',
            expected: [],
            forbidden: ['evt-b'],
            answerKeywords: ['anything']
          }
        ]
      }
    ]
  };
  const result = lintScenarioPack(pack, { strict: true });
  assert.ok(result.findings.some((finding) => finding.code === 'abstention-no-forbidden-set'));
  assert.ok(result.findings.some((finding) => finding.code === 'recall-probe-no-expected'));
}

async function testExtendedPacks() {
  const suitePaths = [
    'benchmarks/interference-stacked.scenarios.json',
    'benchmarks/contradiction-resolution.scenarios.json',
    'benchmarks/noise-near-duplicates.scenarios.json',
    'benchmarks/abstention.scenarios.json'
  ];
  for (const suitePath of suitePaths) {
    const pack = await loadScenarioPack(suitePath);
    const result = lintScenarioPack(pack, { strict: true });
    assert.equal(result.passed, true, `${pack.name} strict lint failures: ${JSON.stringify(result.findings)}`);
  }
  const matrix = await runMatrix({
    suitePaths,
    adapters: ['typed-semantic', 'hybrid'],
    check: true
  });
  assert.equal(matrix.gate.passed, true, `extended matrix failures: ${matrix.gate.failures.join('; ')}`);
}

async function testMatrixAndCalibration() {
  const suitePaths = ['benchmarks/core.scenarios.json', 'benchmarks/audrey-regression.scenarios.json'];
  const matrix = await runMatrix({
    suitePaths,
    adapters: ['typed-semantic', 'hybrid'],
    check: true
  });
  assert.equal(matrix.gate.passed, true);
  assert.equal(matrix.suites.length, 2);
  assert.equal(matrix.adapters.length, 2);

  const calibration = await calibrateMatrix({
    suitePaths,
    adapters: ['typed-semantic', 'hybrid'],
    runs: 2
  });
  assert.equal(calibration.gate.passed, true);
  assert.equal(calibration.stable, true);
}

async function testBaselineCaptureAndCheck() {
  const outputDir = mkdtempSync(join(tmpdir(), 'memorygym-baselines-'));
  const suitePaths = ['benchmarks/core.scenarios.json'];
  const capture = await captureBaselines({
    suitePaths,
    adapters: ['hybrid'],
    runs: 2,
    outputDir
  });

  assert.equal(capture.gate.passed, true);
  assert.equal(capture.baselines.length, 1);
  assert.equal(capture.files.length, 1);

  const artifact = JSON.parse(readFileSync(capture.files[0], 'utf8'));
  assert.equal(artifact.adapter, 'hybrid');
  assert.equal(typeof artifact.suite_fingerprint, 'string');
  assert.equal(typeof artifact.score, 'number');
  assert.equal(artifact.scenarios, undefined);
  assert.equal(artifact.aggregate, undefined);

  const check = await checkBaselines({
    suitePaths,
    adapters: ['hybrid'],
    baselineDir: outputDir,
    maxLatencyRegressionRatio: 100
  });
  assert.equal(check.passed, true);
  assert.equal(check.comparisons[0].status, 'ok');
}

async function testReleaseGate() {
  const report = await runReleaseGate({
    suitePaths: ['benchmarks/core.scenarios.json', 'benchmarks/audrey-regression.scenarios.json'],
    adapters: ['typed-semantic', 'hybrid'],
    audrey: {
      command: process.execPath,
      args: [resolve('package.json')]
    }
  });

  assert.equal(report.passed, true);
  assert.match(report.runId, /^release-/);
  assert.equal(report.baseline.passed, true);
  assert.equal(report.failures.length, 0);
  assert.equal(report.lint.reduce((sum, item) => sum + item.result.warningCount, 0), 0);

  const notes = renderReleaseNotes(report);
  assert.match(notes, /# MemoryGym Release Notes/);
  assert.match(notes, /Baseline Score Delta/);
  assert.match(notes, new RegExp(report.runId));

  const notesWithMethodology = renderReleaseNotes({
    ...report,
    matrix: {
      ...report.matrix,
      adapters: [
        {
          name: 'hybrid',
          meanScore: 0.7,
          minScore: 0.66,
          meanHitRate: 0.9,
          p95RecallLatencyMs: 1.2
        }
      ],
      suites: [
        {
          name: 'Abstention',
          probeKindCounts: { abstention: 3 },
          adapters: [
            {
              name: 'hybrid',
              skippedProbes: [
                {
                  scenarioId: 'native-only',
                  probeId: 'truth',
                  requires: ['memory_resolve_truth'],
                  skipReason: 'adapter does not provide capability: memory_resolve_truth'
                }
              ]
            }
          ]
        }
      ]
    },
    baseline: {
      ...report.baseline,
      comparisons: [
        {
          adapter: 'hybrid',
          status: 'ok',
          scoreDelta: 0,
          hitRateDelta: 0,
          latencyRatio: 1
        }
      ]
    }
  });
  assert.match(notesWithMethodology, /## What Changed/);
  assert.match(notesWithMethodology, /## Methodology/);
  assert.match(notesWithMethodology, /Abstention Probes/);
  assert.match(notesWithMethodology, /## Skipped Capabilities/);
  assert.match(notesWithMethodology, /memory_resolve_truth/);
}

async function testCompareReports() {
  const baseAdapter = {
    name: 'hybrid',
    aggregate: {
      score: 0.8,
      hitRate: 1,
      recallLatencyMs: { p95: 10 }
    }
  };
  const candidateAdapter = {
    name: 'hybrid',
    aggregate: {
      score: 0.7,
      hitRate: 0.8,
      recallLatencyMs: { p95: 30 }
    }
  };
  const comparison = compareReports(
    { runId: 'base', suite: { name: 'test' }, adapters: [baseAdapter] },
    { runId: 'candidate', suite: { name: 'test' }, adapters: [candidateAdapter] },
    { minScoreDelta: -0.02, maxLatencyRegressionRatio: 2 }
  );

  assert.equal(comparison.passed, false);
  assert.equal(comparison.failures.length, 2);
}

async function testMcpStdoutBufferCap() {
  const client = new McpStdioClient({ command: 'node' });
  let killed = false;
  client.process = {
    kill(signal) {
      killed = signal === 'SIGKILL';
    }
  };
  client.handleStdout('x'.repeat((4 * 1024 * 1024) + 1));
  assert.equal(killed, true);
  assert.equal(client.buffer, '');
}

async function testAudreyMcpPersistentChild() {
  const adapter = new AudreyMcpAdapter({
    command: 'node',
    args: ['ignored.js'],
    dataDir: mkdtempSync(join(tmpdir(), 'memorygym-persistent-'))
  }, { runId: 'persistent-test' });

  let ensureCalls = 0;
  let warmupCalls = 0;
  let closeCalls = 0;
  adapter.ensureStarted = async () => { ensureCalls += 1; };
  adapter.warmup = async () => { warmupCalls += 1; };
  adapter.close = async () => { closeCalls += 1; };

  await adapter.reset({ id: 'scenario-one' });
  await adapter.reset({ id: 'scenario-two' });
  await adapter.reset({ id: 'scenario-three' });

  assert.equal(adapter.persistentChild, true, 'persistentChild should default to true');
  assert.equal(closeCalls, 0, 'persistent child should not close between scenarios');
  assert.equal(ensureCalls, 3, 'reset should ensure the client is started each time');
  assert.equal(warmupCalls, 3, 'warmup should run each reset');
  assert.equal(adapter.scenarioId, 'scenario-three', 'scenarioId tracks the current scenario');

  const isolated = new AudreyMcpAdapter({
    command: 'node',
    args: ['ignored.js'],
    persistentChild: false,
    dataDir: mkdtempSync(join(tmpdir(), 'memorygym-isolated-'))
  }, { runId: 'isolated-test' });
  let isolatedCloseCalls = 0;
  isolated.ensureStarted = async () => {};
  isolated.warmup = async () => {};
  isolated.close = async () => { isolatedCloseCalls += 1; };
  await isolated.reset({ id: 'scenario-one' });
  await isolated.reset({ id: 'scenario-two' });
  assert.equal(isolated.persistentChild, false);
  assert.equal(isolatedCloseCalls, 2, 'isolated mode closes child between scenarios');
}

async function testDoctor() {
  const report = await inspectMemoryGym({
    audrey: {
      command: 'node',
      args: ['audrey.js']
    }
  });

  assert.ok(report.adapters.local.includes('hybrid'));
  assert.equal(report.audrey.configured, true);
  assert.equal(report.audrey.entrypoint, 'audrey.js');

  const missingConfig = await inspectMemoryGym({
    audrey: {
      configPath: join(tmpdir(), 'memorygym-missing-codex-config.toml')
    }
  });
  assert.equal(missingConfig.audrey.configured, false);
  assert.match(missingConfig.audrey.error, /config not found/);
}

async function testCliFirstContact() {
  const packageJson = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));
  const version = runCli(['--version']);
  assert.equal(version.status, 0);
  assert.equal(version.stdout.trim(), packageJson.version);

  const globalHelp = runCli(['-h']);
  assert.equal(globalHelp.status, 0);
  assert.match(globalHelp.stdout, /MemoryGym 0\.1\.0/);

  const runHelp = runCli(['run', '--help']);
  assert.equal(runHelp.status, 0);
  assert.match(runHelp.stdout, /MemoryGym run/);

  const shortHelpAfterBoolean = runCli(['run', '--audrey', '-h']);
  assert.equal(shortHelpAfterBoolean.status, 0);
  assert.match(shortHelpAfterBoolean.stdout, /MemoryGym run/);

  const unknown = runCli(['definitely-not-a-command']);
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /Unknown command: definitely-not-a-command/);
  assert.match(unknown.stderr, /Run 'memorygym --help' for usage\./);
  assert.doesNotMatch(unknown.stderr, /\n\s+at /);

  const manifest = runCli(['manifest'], { cwd: tmpdir() });
  assert.equal(manifest.status, 0, manifest.stderr);
  const parsed = JSON.parse(manifest.stdout);
  assert.equal(parsed.name, 'MemoryGym Core');
}

function runCli(args, options = {}) {
  return spawnSync(process.execPath, [resolve('src/cli.js'), ...args], {
    cwd: options.cwd ?? process.cwd(),
    env: {
      ...process.env,
      NO_COLOR: '1',
      ...(options.env ?? {})
    },
    encoding: 'utf8'
  });
}

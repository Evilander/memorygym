import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export async function writeHtmlReport(report, outputPath) {
  const path = resolve(outputPath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, renderHtml(report), 'utf8');
}

function renderHtml(report) {
  const rows = report.adapters.map((adapter) => `
    <tr>
      <td>${escapeHtml(adapter.name)}</td>
      <td>${formatScore(adapter.aggregate.score)}</td>
      <td>${formatScore(adapter.aggregate.hitRate)}</td>
      <td>${formatScore(adapter.aggregate.precision)}</td>
      <td>${formatScore(adapter.aggregate.recall)}</td>
      <td>${adapter.aggregate.skippedCount ?? 0}</td>
      <td>${adapter.aggregate.recallLatencyMs.p95.toFixed(1)}ms</td>
    </tr>`).join('');

  const scenarios = report.adapters.map((adapter) => `
    <section>
      <h2>${escapeHtml(adapter.name)}</h2>
      ${adapter.scenarios.map((scenario) => `
        <article>
          <h3>${escapeHtml(scenario.title)} <span>${formatScore(scenario.score)}${scenario.skippedCount ? ` - ${scenario.skippedCount} skipped` : ''}</span></h3>
          <table>
            <thead><tr><th>Probe</th><th>Score</th><th>Hit</th><th>Top Recall</th><th>Status</th></tr></thead>
            <tbody>
              ${scenario.probes.map((probe) => `
                <tr>
                  <td>${escapeHtml(probe.id)}</td>
                  <td>${probe.skipped ? 'skipped' : formatScore(probe.scoring.score)}</td>
                  <td>${probe.skipped ? 'n/a' : (probe.scoring.hitRate ? 'yes' : 'no')}</td>
                  <td>${escapeHtml(probe.recalls[0]?.id ?? 'none')}</td>
                  <td>${escapeHtml(probe.skipReason ?? (probe.requires?.length ? `requires ${probe.requires.join(', ')}` : 'scored'))}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </article>`).join('')}
    </section>`).join('');

  const data = JSON.stringify(report).replace(/</g, '\\u003c');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>MemoryGym Report - ${escapeHtml(report.suite.name)}</title>
  <style>
    :root { color-scheme: light; --ink: #1c2420; --muted: #66736d; --line: #d6ded7; --panel: #f7f8f3; --accent: #0f766e; --warn: #a15c13; }
    body { margin: 0; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: var(--ink); background: #fbfbf8; }
    header { padding: 28px 32px 18px; border-bottom: 1px solid var(--line); background: #ffffff; }
    main { max-width: 1180px; margin: 0 auto; padding: 28px 24px 48px; }
    h1 { margin: 0 0 8px; font-size: 28px; letter-spacing: 0; }
    h2 { margin: 34px 0 14px; font-size: 20px; letter-spacing: 0; }
    h3 { display: flex; justify-content: space-between; gap: 16px; margin: 22px 0 10px; font-size: 16px; letter-spacing: 0; }
    p { margin: 0; color: var(--muted); }
    .summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin: 18px 0 28px; }
    .metric { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 14px; }
    .metric b { display: block; font-size: 22px; margin-top: 4px; }
    table { width: 100%; border-collapse: collapse; background: #ffffff; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
    th, td { padding: 10px 12px; text-align: left; border-bottom: 1px solid var(--line); font-size: 14px; vertical-align: top; }
    th { color: var(--muted); font-weight: 600; background: #f2f5f0; }
    tr:last-child td { border-bottom: 0; }
    article { margin-bottom: 24px; }
    .gate { color: ${report.gate.passed === false ? 'var(--warn)' : 'var(--accent)'}; }
    @media (max-width: 760px) { header { padding: 22px 18px; } main { padding: 18px; } .summary { grid-template-columns: 1fr 1fr; } th, td { padding: 9px 8px; } }
  </style>
</head>
<body>
  <header>
    <h1>MemoryGym Report</h1>
    <p>${escapeHtml(report.suite.name)} ${escapeHtml(report.suite.version ?? '')} · ${escapeHtml(report.generatedAt)} · run ${escapeHtml(report.runId)}</p>
  </header>
  <main>
    <div class="summary">
      <div class="metric">Winner<b>${escapeHtml(report.summary.winner ?? 'none')}</b></div>
      <div class="metric">Adapters<b>${report.adapters.length}</b></div>
      <div class="metric">Scenarios<b>${report.suite.scenarioCount}</b></div>
      <div class="metric">Gate<b class="gate">${report.gate.enabled ? (report.gate.passed ? 'passed' : 'failed') : 'off'}</b></div>
    </div>
    <h2>Leaderboard</h2>
    <table>
      <thead><tr><th>Adapter</th><th>Score</th><th>Hit Rate</th><th>Precision</th><th>Recall</th><th>Skipped</th><th>P95 Recall</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${scenarios}
  </main>
  <script type="application/json" id="memorygym-report">${data}</script>
</body>
</html>`;
}

function formatScore(value) {
  if (!Number.isFinite(value)) {
    return 'n/a';
  }
  return `${(Number(value ?? 0) * 100).toFixed(1)}%`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

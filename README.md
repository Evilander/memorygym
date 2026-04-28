# MemoryGym

[![npm version](https://img.shields.io/npm/v/memorygym.svg)](https://www.npmjs.com/package/memorygym)
[![CI](https://github.com/Evilander/memorygym/actions/workflows/ci.yml/badge.svg)](https://github.com/Evilander/memorygym/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/node/v/memorygym.svg)](package.json)

**A release gate for agent memory.** MemoryGym replays structured scenarios against memory adapters, scores retrieval behavior with contamination-aware metrics, and writes locked baselines so regressions fail loudly.

Most "memory" benchmarks ask whether a fact can be recalled once. That bar is too low. MemoryGym measures whether your adapter:

- surfaces the **current** belief after the world updates,
- **abstains** when nothing is grounded instead of fabricating from lexical overlap,
- routes by **context** when several memories share keywords,
- survives **interference** from a long tail of stale variants of the same key,
- and stays **stable** across repeated runs.

Six local baseline adapters and two external Audrey adapters ship in the box. New adapters are a four-method interface away.

```sh
npx memorygym run --adapters hybrid --check
```

## Why this exists

Agent memory is becoming a real product surface — mem0, Letta, Zep, MemGPT, Audrey, LangMem, Cognee — but most demos prove only that *something* is retrievable. They don't show what happens when:

- the user contradicts themselves at session 12 and the system needs to converge on the corrected belief,
- five entities share the same `key: deploy_window` and only context disambiguates,
- the agent asks about a team that was never observed and a confident fabrication would be worse than silence,
- twelve sequential workspace flips all share keywords and only the most recent is right.

MemoryGym is opinionated about all of those. The bundled scenario packs are designed to be losable by adapters that win on lexical overlap alone. See [`docs/opinions.md`](docs/opinions.md) for the design thesis and [`docs/scoring.md`](docs/scoring.md) for the score-formula derivation.

## Quickstart

```sh
# Score the local baselines on the bundled core suite
npx memorygym run --adapters typed-semantic,hybrid --check

# Run all six bundled scenario packs across two adapters
npx memorygym matrix \
  --suites benchmarks/core.scenarios.json,benchmarks/audrey-regression.scenarios.json \
  --adapters typed-semantic,hybrid --check

# Lock the current numbers as the regression baseline
npx memorygym baseline capture --adapters typed-semantic,hybrid --runs 5

# Run the full release gate (diagnostics + lint + matrix + baseline check + markdown notes)
npx memorygym release \
  --suites benchmarks/core.scenarios.json,benchmarks/audrey-regression.scenarios.json \
  --adapters typed-semantic,hybrid
```

For local development:

```sh
npm install      # zero runtime deps; this just primes the cache
npm test         # 22 in-process tests
npm run release:gate
```

JSON and HTML reports land in `reports/`.

## Real-world story: the Audrey perf pass

The first project that adopted MemoryGym as a release gate was [Audrey](https://github.com/Evilander/Audrey), a biological-memory MCP server. The first live integration produced this:

| Metric | Live benchmark |
| --- | ---: |
| `audrey-mcp` score | 75.9% |
| `hybrid` baseline score | 78.2% |
| `audrey-mcp` observe p95 | **2180ms** |
| `audrey-mcp` recall p95 | 59.5ms |

The headline 60ms recall looked fine. But the per-scenario observe p95 was 2.18 seconds, and a single probe (`negative-space-forgotten/isolated-data-policy`) accounted for the entire 2.3pp score gap — Audrey put a *status* memory above a *policy* memory because both shared "audrey live data" tokens. None of that would have been visible from a one-shot recall test.

A profile-driven optimization pass ([Audrey v0.22.0](https://github.com/Evilander/Audrey/pull/18)) followed:

| Metric | Before | After |
| --- | ---: | ---: |
| Cold-start first encode | 525ms | 28ms (18.7×) |
| Encode response p50 | 24.7ms | 15.2ms (1.6×) |
| Hybrid recall p50 | 30.2ms | 14.3ms (2.1×) |
| Embed calls per encode | 4 | 1 |
| SQL roundtrips per recall | 4 | 2 |

The wins were concrete because each one was measurable inside MemoryGym's report. That is the loop the harness is built to enable.

## What it measures

| Metric | Description |
| --- | --- |
| `hitRate` | binary 1/0 — at least one expected event in top-K |
| `precision`, `recall` | classic IR over top-K |
| `mrr` | reciprocal rank of the first match |
| `ndcg` | gain at top-K / ideal gain at top-K |
| `answerQuality` | fraction of `answerKeywords` whose tokens appear in any recalled content |
| `contaminationPenalty` | `min(1, |forbidden ∩ returned| / |returned|)` |
| `recallLatencyMs` | avg / p50 / p95 / max |
| `score` | composite — see [`docs/scoring.md`](docs/scoring.md) |

The composite score weights `hitRate` and `contaminationPenalty` equally (`0.28` each). A high-confidence wrong answer costs as much as a correct one earns. Adapters that maximize hits at the expense of contamination cannot trade their way to a higher score.

For abstention probes, scoring inverts: returning **nothing high-confidence** scores 1.0; returning a forbidden answer at high confidence scores 0.

## Bundled scenario packs

The release gate runs the **core** and **audrey-regression** packs. The **extended** packs are opt-in via `npm run bench:extended` or `npm run bench:all`.

| Pack | What it measures | Inspired by |
| --- | --- | --- |
| `core.scenarios.json` | Typed profile updates, episodic incident threads, decay vs. salience, project-routed retrieval | original MemoryGym design |
| `audrey-regression.scenarios.json` | Live-symptom-over-docs authority, project memory routing, tool-trace learning, source-of-truth calendars, near-duplicate negative space | real Audrey operational failure modes |
| `interference-stacked.scenarios.json` | 12 sequential entity:key flips and a stacked on-call rotation; final value must win | PI-LLM (arXiv 2506.08184) |
| `contradiction-resolution.scenarios.json` | Reinforced beliefs overturned by board decisions and incident reviews | BeliefShift (arXiv 2603.23848) |
| `noise-near-duplicates.scenarios.json` | Five high-overlap deploy windows and post-mortems; only one matches the asked context | scoring red-team |
| `abstention.scenarios.json` | Unobserved teams, incidents, and policies; adapter must decline rather than fabricate | LongMemEval refusal probes |
| `audrey-capabilities.scenarios.json` | Audrey-only native tool exercise — `memory_resolve_truth`, `memory_dream`, `memory_observe_tool`, `memory_preflight`, `memory_reflexes` | Audrey MCP surface |

## Probe kinds

MemoryGym ships three probe kinds. Each carries different scoring semantics and different lint rules.

### `recall` (default)

Adapter must return one or more `expected` event IDs in the top K. Forbidden events lower the score; `answerKeywords` coverage shapes `answerQuality`.

```json
{
  "id": "current-workspace",
  "query": "Which collaboration environment should Maya use right now?",
  "expected": ["maya-workspace-current"],
  "forbidden": ["maya-workspace-old"],
  "answerKeywords": ["Maya", "Aurora"],
  "topK": 3
}
```

### `abstention`

Adapter must NOT surface a high-confidence answer for a question with no grounded memory. Declares `expected: []`, a `forbidden` set of tempting wrong answers, and an `abstainThreshold` (default `0.4`). An adapter scores 1.0 only if no result clears the threshold AND no forbidden item appears at high confidence.

```json
{
  "id": "growth-team-lead-unobserved",
  "kind": "abstention",
  "query": "Who leads the Growth Marketing team this quarter?",
  "expected": [],
  "forbidden": ["team-platform-lead", "team-payments-lead", "team-search-lead"],
  "abstainThreshold": 0.4,
  "topK": 3
}
```

### `capability`

Adapter must expose a specific native MCP tool and that tool must succeed when called. Used for vendor-specific probes (Audrey's `memory_dream`, `memory_resolve_truth`, etc.). Adapters that don't expose the required capability mark the probe **skipped** — skipped probes do not lower the aggregate score.

```json
{
  "id": "dream-consolidation",
  "kind": "capability",
  "query": "Run a dream cycle and verify clusters were created",
  "requires": ["memory_dream"],
  "expected": [],
  "capabilityArgs": {
    "memory_dream": { "min_cluster_size": 2, "similarity_threshold": 0.55 }
  }
}
```

A JSON Schema for scenario packs ships at [`src/schema/pack.schema.json`](src/schema/pack.schema.json) (Draft 2020-12).

## Adapter contract

```js
export class MyAdapter {
  name = 'my-adapter';
  kind = 'external';

  // Optional: declare native capabilities so capability-gated probes resolve correctly
  get capabilities() {
    return ['memory_encode', 'memory_recall'];
  }

  async reset(scenario) {}                   // called before each scenario
  async observe(event) {}                    // append-only memory write
  async recall(query, options) {             // ranked retrieval
    return [
      { id: 'event-id', content: 'recalled memory text', score: 0.9 }
    ];
  }
  async close() {}                           // tear down resources
}
```

`observe` receives normalized event tags and context. `recall` should return ranked results with stable IDs when possible. External systems can attach backend-specific telemetry under `diagnostics`; MemoryGym preserves it in JSON reports.

Built-in Audrey adapters:

```sh
npx memorygym run --audrey      --audrey-embedding-provider mock     # spawns local MCP child
npx memorygym run --audrey-http --audrey-http-base-url http://127.0.0.1:7437
```

Audrey benchmarks default to an isolated `.memorygym/audrey-runs` data directory; the live Audrey store is refused unless `--allow-live-audrey-data` is set explicitly.

## Security defaults

- **Env allowlist for spawned children.** MemoryGym passes only `PATH`, `HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `SystemRoot`, `windir`, `TEMP`, `TMP`, `NODE_ENV`, plus everything starting with `AUDREY_` and `MEMORYGYM_`. Set `MEMORYGYM_PASS_ENV=1` only for trusted local debugging.
- **Localhost-only HTTP.** `--audrey-http-base-url` is restricted to `http://localhost`, `http://127.0.0.1`, or `http://[::1]`. Use `--allow-remote-audrey` only for a trusted remote Audrey service; otherwise the API key is never sent over the wire.
- **Command allowlist.** Audrey's launch command must be `node`/`node.exe` or the configured Audrey entrypoint. `--allow-arbitrary-audrey-command` opts out for power users.
- **Live-data guard.** The Audrey adapter refuses to write to `~/.audrey/data` (or any symlink resolving to it) unless explicit live-data access is granted.

## Release gate

```sh
npx memorygym release \
  --suites benchmarks/core.scenarios.json,benchmarks/audrey-regression.scenarios.json \
  --adapters typed-semantic,hybrid
```

Combines into a single artifact:

1. **Diagnostics** — Node version, cwd, Audrey config presence + paths.
2. **Strict suite lint** — duplicate IDs, broken expected/forbidden references, thin event content, query-leaks-event-id, missing answerKeywords, missing forbidden sets on abstention probes.
3. **Multi-suite matrix** — score / hitRate / latency for every adapter on every suite, plus aggregated min/mean.
4. **Baseline check** — fingerprint-keyed regression detection vs. locked baselines under `reports/baselines/`. New adapters MUST capture a baseline before the gate passes; missing baselines fail loudly.
5. **Markdown release notes** — auto-written at `reports/release-notes-<runId>.md`. Pass `--notes path.md` for a second copy at a stable path.

## Baseline locks

```sh
# Capture (after intentional behavior change)
npx memorygym baseline capture --adapters typed-semantic,hybrid --runs 5

# Check (CI)
npx memorygym baseline check  --adapters typed-semantic,hybrid
```

Baselines are stored as small aggregate-only JSON under `reports/baselines/<adapter>@<version>.json`, keyed on a SHA-256 fingerprint of the suite set. Changing a single character of any scenario file changes the fingerprint and forces a re-capture — a feature, not a bug.

## CLI reference

```
memorygym --version
memorygym --help
memorygym run [--suite path] [--adapters a,b,c] [--audrey] [--audrey-http] [--check]
memorygym matrix --suites a,b --adapters x,y --check
memorygym calibrate --suites a,b --adapters x,y --runs 3
memorygym baseline capture --suites a,b --adapters x,y --runs 5
memorygym baseline check  --suites a,b --adapters x,y
memorygym release --suites a,b --adapters x,y [--notes notes.md]
memorygym compare --baseline old.json --candidate new.json
memorygym lint --suites a,b --strict
memorygym manifest [--suite path]
memorygym doctor
memorygym list
memorygym <command> --help
```

Set `MEMORYGYM_DEBUG=1` to surface stack traces from CLI errors. Set `NO_COLOR=1` to disable styled output.

## Project layout

```
benchmarks/        # JSON scenario packs (versioned)
docs/              # opinions.md (thesis) + scoring.md (formula derivation)
reports/baselines/ # Locked baseline artifacts (committed to git)
src/
  adapters/        # baseline + audrey-mcp + audrey-http adapters
  mcp/             # JSON-RPC stdio client
  schema/          # JSON Schema for scenario packs
  cli.js           # entry point
  runner.js        # scenario loop, gate evaluation
  score.js         # scoring (recall + abstention + capability)
  baseline.js      # locked-baseline capture + check
  release.js       # combined release-gate orchestrator
  release-notes.js # markdown report generator
  ...
tests/run.js       # 22 in-process tests
.github/workflows/ # CI matrix on Node 22 + 24, OIDC publish with provenance + SBOM
```

## Contributing

- Issues + PRs on [github.com/Evilander/memorygym](https://github.com/Evilander/memorygym)
- New scenario packs are very welcome. Run `npx memorygym lint --suites your-pack.json --strict` before opening a PR.
- The harness has zero runtime dependencies. Please keep it that way unless a dep removes real complexity.
- See [`docs/opinions.md`](docs/opinions.md) before arguing with the scoring weights.

## License

[MIT](LICENSE) © Tyler Eveland

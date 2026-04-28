# Changelog

All notable changes to MemoryGym are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Audrey adapters (`audrey-mcp`, `audrey-http`) now persist a single MCP/HTTP child process across all scenarios within an adapter run. Each scenario keeps its own tag/context isolation; the data directory is shared. Pass `--audrey-isolate-scenarios` to opt back into the previous per-scenario respawn behavior.
- `audrey-mcp.warmup()` issues a `memory_status` call after the child starts and before the first probe timer, so embedding-model load and other cold-start costs are excluded from per-probe latency measurements.
- Audrey-native capability gating with probe `requires`, skipped-probe reporting, and an Audrey-only capability pack covering `memory_resolve_truth`, `memory_observe_tool`, `memory_dream`, `memory_preflight`, and `memory_reflexes`.
- Abstention probe type (`kind: "abstention"`) with configurable `abstainThreshold`. Adapters that return high-confidence forbidden recalls on unobserved questions are penalized; quiet adapters that defer score 1.0.
- Four extended scenario packs covering known agent-memory failure modes:
  - `interference-stacked.scenarios.json` — twelve sequential workspace flips and an on-call rotation stack inspired by PI-LLM (arXiv 2506.08184).
  - `contradiction-resolution.scenarios.json` — reinforced beliefs overturned by board decisions and incident reviews; tests belief revision under conflict.
  - `noise-near-duplicates.scenarios.json` — multiple high-overlap deploy windows and post-mortems that share keywords; designed to expose adapters that win on lexical overlap alone.
  - `abstention.scenarios.json` — refusal probes for unobserved teams, incidents, and policies inspired by LongMemEval.
- `bench:extended` and `bench:all` npm scripts that run the new packs alongside the core/regression suites.
- Strict lint rules for abstention probes (`abstention-no-forbidden-set`, `abstention-threshold-range`, `recall-probe-no-expected`, `probe-kind-unknown`).
- JSON Schema for scenario packs at `src/schema/pack.schema.json` (Draft 2020-12).
- New tests covering abstention scoring, abstention-aware lint, and the full extended pack matrix.
- Markdown release notes now include abstention methodology, skipped capability probes, and a changelog-derived "What changed" summary.

### Changed
- Strict lint now distinguishes `recall` and `abstention` probes; recall probes must declare a non-empty `expected` set, while abstention probes must declare a `forbidden` set and may omit answer keywords.
- Lint suites script now lints all seven bundled scenario packs (was only core + regression).
- `package.json` description, keywords, repository, bugs, and homepage metadata polished for npm.

## [0.1.0] - 2026-04-27

### Added
- Node.js ESM CLI with `run`, `list`, `doctor`, `manifest`, `compare`, `lint`, `matrix`, `calibrate`, `release` commands.
- Local baseline adapters: `stateless`, `episodic`, `semantic`, `typed-semantic`, `decayed`, `hybrid`.
- Audrey MCP and HTTP adapters with isolated `.memorygym/audrey-runs` data directories and a guard against the live Audrey store.
- Scoring covering hit rate, precision, recall, MRR, NDCG, answer keyword coverage, and contamination penalties.
- Latency summaries (avg, p50, p95, max) per scenario and adapter.
- JSON and standalone HTML reports written under `reports/`.
- Strict suite linting, multi-suite matrix runs, and stability calibration.
- Aggregate-only baseline lock files at `reports/baselines/<adapter>@<version>.json` keyed on a SHA-256 fingerprint of the suite set.
- Release-gate JSON artifact and markdown release-notes generator.
- README with quickstart, methodology, scenario schema, and adapter contract.
- MIT license, `package.json` files allowlist, GitHub Actions CI matrix on Node 22 and 24, and an OIDC-backed publish workflow with provenance and SBOM generation.
- In-process Node test harness covering the runner, scoring, lint, baseline, release gate, comparison, doctor, manifest, and CLI first-contact paths.

[Unreleased]: https://github.com/evilander/memorygym/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/evilander/memorygym/releases/tag/v0.1.0

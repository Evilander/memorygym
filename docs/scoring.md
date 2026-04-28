# MemoryGym Scoring

This document explains the composite score formula in `src/score.js`, the trade-offs each weight encodes, and how to interpret aggregate adapter scores.

## Recall probes (`kind: "recall"`, default)

For a single probe with top-K returned recalls, MemoryGym computes:

| Metric | Definition | Source |
| --- | --- | ---: |
| `hitRate` | `1` if at least one expected event ID is in top-K, else `0` | binary |
| `precision` | `matched / |returned|` | classic IR |
| `recall` | `matched / |expected|` (or `1` if `expected` is empty) | classic IR |
| `mrr` | reciprocal rank of the first matched expected ID | Voorhees, 1999 |
| `ndcg` | gain at top-K / ideal gain at top-K | Järvelin & Kekäläinen, 2002 |
| `answerQuality` | fraction of `answerKeywords` whose every token appears in any recalled content | bag-of-words |
| `contaminationPenalty` | `min(1, |forbidden in returned| / |returned|)` | MemoryGym-specific |

The composite is:

```
score = clamp01(
    hitRate              * 0.28
  + recall               * 0.22
  + precision            * 0.16
  + mrr                  * 0.16
  + ndcg                 * 0.10
  + answerQuality        * 0.08
  - contaminationPenalty * 0.28
)
```

### Why these weights

**`hitRate` and `contaminationPenalty` are tied at `0.28`.** A quietly missed retrieval costs the same as a confidently wrong one. This is deliberate. Adapters that maximize hits at the cost of forbidden contamination cannot trade their way to a higher score; the symmetry forces them to actually distinguish relevant from tempting.

**`recall (0.22) > precision (0.16)`.** When a probe declares multiple expected events, finding more of them matters more than ranking purity. This rewards systems that return the full evidence set instead of just the first plausible one.

**`mrr (0.16) > ndcg (0.10)`.** The first-position bias is heavier than graded position discounting. In a memory-recall context, the first-place answer is what gets surfaced to the agent loop; the rest is rationale. We weight the ranker on its top result more than its tail.

**`answerQuality (0.08)` is small.** Keyword coverage is a content-grounding sanity check, not a primary signal. We do NOT want adapters competing on token overlap with arbitrary keyword lists; that path leads back to the lexical-hallucination failure mode the harness is built to expose.

**Total positive weights sum to `1.0`; contamination subtracts up to `0.28`.** A worst-case adapter can reach `-0.28` and is clamped to `0`. A best-case adapter that hits everything cleanly tops out at `1.0`.

### What this scoring does NOT measure

- Embedding quality directly (we measure its downstream effect on retrieval)
- Latency (reported separately as `recallLatencyMs.{avg,p50,p95,max}`)
- Memory consolidation depth (use the `audrey-capabilities.scenarios.json` pack, which tests `memory_dream` directly)
- Calibration of adapter-reported confidence scores (planned via Expected Calibration Error metric in a future release)

## Abstention probes (`kind: "abstention"`)

For probes asking about facts that were never observed, scoring inverts to:

```
correctAbstention =
  if expected is empty:
    no high-confidence results AND no high-confidence forbidden returns
  else:
    expected event returned at high confidence AND no high-confidence forbidden returns

score = clamp01((correctAbstention ? 1 : 0) - contaminationPenalty * 0.5)
```

A high-confidence return is one whose adapter-reported `score` is `>= probe.abstainThreshold` (default `0.4`).

### Why abstention contamination is `0.5` (not `0.28`)

For abstention, contamination IS the failure mode being tested. If the adapter returns 3 high-confidence forbidden items, we want the score to be near zero, not just below the gate. A `0.5` weight ensures any meaningful contamination drags the score down sharply.

### The silent-failure trap

We deliberately reject the design where "adapter returned nothing" always scores 1.0. If a probe declares non-empty `expected` (i.e., there IS a correct answer the adapter should have surfaced), abstaining is *wrong* and scores 0. An adapter that pretends to be cautious by returning nothing on known-answer questions cannot pass.

This was a real bug in an earlier iteration of the scoring code; the regression test `silent adapter on probe with expected answer must not score 1` in `tests/run.js` guards against it.

## Capability probes (`kind: "capability"`)

```
score = adapter exposes ALL of probe.requires AND adapter.runCapabilityProbe resolves successfully
      ? 1.0
      : 0.0  (or "skipped" if adapter doesn't expose the capabilities)
```

Skipped capability probes are reported as `null` score and excluded from adapter aggregate averaging. A scenario whose probes are *all* skipped reports `aggregate.score = "n/a"` rather than `0`, so adapters lacking required tools are not penalized for their absence.

The intent is to let Audrey-only or vendor-specific capabilities be tested without making them the default. The bundled `audrey-capabilities.scenarios.json` pack runs cleanly against `hybrid` (all probes skipped, no failure) and exercises the actual MCP tools against `audrey-mcp`.

## Aggregate composition

Per scenario:
- `score` = mean of its non-skipped probe scores (or `null` if all probes are skipped)

Per adapter (across scenarios in a suite):
- `score` = mean of non-null scenario scores
- `hitRate` = mean of probe `hitRate` values
- `precision`, `recall`, `mrr`, `ndcg`, `answerQuality`, `contaminationPenalty` = mean of probe values
- `recallLatencyMs.{avg,p50,p95,max}` = computed across all probes
- `skippedCount` = total number of skipped probes

Per matrix (across multiple suites):
- `meanScore`, `minScore` = aggregated across suite × adapter results
- `gate.passed` = all per-suite per-adapter gates pass

## Sensitivity to adversarial adapters

We acknowledge that any closed-form weight scheme is gameable. The bundled scenario packs are designed to make several gaming strategies cost more than they earn:

- **Token spam adapters** (return everything that lexically overlaps): caught by `noise-near-duplicates.scenarios.json` where five events share keywords and only one matches the asked context.
- **Recency-only adapters**: caught by `core.scenarios.json::decay-vs-salience` where a 24-day-old high-salience invariant must beat a 1-day-old low-salience polish note.
- **Typed-metadata-only adapters**: caught by `noise-near-duplicates::deploy-window-noise` where five entities share the same `key: deploy_window` and only context disambiguates.
- **Confidently-confused adapters**: caught by `abstention.scenarios.json` where high-confidence wrong answers explicitly score 0.

Future calibration work (`memorygym calibrate --derive-weights`) is planned to fit weights from labeled human-agreement data rather than the current opinionated defaults.

## Roadmap

- `--scoring-profile {default,strict,lenient}` to surface weight sensitivity
- Expected Calibration Error (ECE) metric for adapters that report confidence
- Permutation-stability metric (run each probe N times with shuffled tie-breakers)
- Contradiction-resolution lag metric (probes between flip event and first correct recall)
- Embedding-similarity-based answerQuality alternative to bag-of-words

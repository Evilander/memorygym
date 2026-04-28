# Why MemoryGym Exists

Most memory benchmarks measure whether a fact can be recalled once. That is a low bar that almost any retrieval system clears, and a high-confidence wrong answer in production destroys more user trust than a quietly missed retrieval. MemoryGym exists because the interesting failures of agent memory are not "did the system find the fact" — they are:

- **stale belief surviving past its update**, after the system was *told* the world changed
- **lexical hallucination** when a question shares vocabulary with neighboring memories but no actually-relevant memory exists
- **interference** when a single entity has been updated 12 times and the system surfaces the wrong revision
- **loud refusal of a fact that exists, dressed up as caution**

The harness is shaped around those failures, not around the comfortable cases.

## What MemoryGym believes

1. **A high-confidence wrong answer should cost as much as a correct answer earns.** Contamination penalty in the recall scoring is `0.28` — the same weight as hit rate. We refuse to ship benchmarks where lying gracefully scores better than admitting nothing.

2. **Abstention is a first-class behavior.** A memory system that surfaces three weak fabricated leads when the truth is "we never saw that" is worse than silence. Abstention probes (`kind: "abstention"`) score 1.0 only when the system declines AND avoids high-confidence forbidden recalls; an adapter that fakes confidence on unfamiliar territory cannot pass.

3. **Lexical overlap is not memory.** The bundled `noise-near-duplicates` pack stacks five high-overlap deploy windows for unrelated services with only one matching the asked context. An adapter that wins on jaccard and loses on context routing fails the gate. Token-set scoring is the floor, not the ceiling, of what we measure.

4. **Reproducibility before ranking.** Every report carries the suite fingerprint (SHA-256 of the stable JSON). `baseline check` refuses to compare across changed suites — better to fail loudly than declare a victory against a moving target.

5. **Calibration is part of the metric.** A score that drifts more than 1 standard deviation across three repeats does not pass calibration. Single-run leaderboard numbers are not credible.

6. **Native capabilities should not be hidden behind score averages.** When an adapter declares it lacks `memory_dream`, scenarios that require dreaming are *skipped*, not silently failed. The HTML report and markdown release notes surface the skipped count so reviewers can see what was tested and what was not.

## What MemoryGym refuses to do

- **Score adapters on a single run.** `calibrate` defaults to 3 runs; release gates require stable behavior. We will not ship leaderboards where the winner changes day-to-day on the same data.

- **Hide synthetic data behind credibility.** The bundled packs are openly synthetic (alphabetically-named workspaces, generic incident post-mortems). They are *baselines* against which real-data packs should be calibrated, not the final word on memory quality. We expect ingesters from real corpora to ship in subsequent releases.

- **Treat MCP server output as trustworthy.** The harness allowlists environment variables forwarded to the spawned Audrey/MCP child, refuses arbitrary launch commands without `--allow-arbitrary-audrey-command`, restricts HTTP base URLs to localhost without `--allow-remote-audrey`, and caps the MCP stdout buffer. A benchmark tool that exfiltrates secrets to whatever binary the user's config points at is malware in evaluation costume.

- **Promise that scoring weights are universally correct.** They are documented choices (`docs/scoring.md`) with explicit trade-offs. We expect every adopter to disagree with at least one weight; the pluggable `--scoring-profile` work is on the roadmap so they can express that disagreement programmatically rather than forking the harness.

## Where we expect to be wrong

- The current scoring weights have not been calibrated against human inter-rater agreement. They are an opinionated starting point. If you have labeled data showing they're miscalibrated, open an issue.

- The local baseline adapters (`stateless`, `episodic`, `semantic`, `typed-semantic`, `decayed`, `hybrid`) exist for sanity-checking the harness, not as serious memory systems. Treat them as the regression line, not the ceiling.

- The tokenizer in `src/text.js` strips an English-language stop-word list. Multi-language benchmarks will show lower-than-true scores on `answerQuality` until we ship language-aware tokenization.

- Audrey is the only external adapter today. Adapters for `mem0`, `letta`, and `zep` are the next high-leverage additions and are explicitly invited as community contributions.

The point is not that MemoryGym is finished. The point is that everything it does is documented, every choice is contestable, and it refuses to ship results it cannot defend.

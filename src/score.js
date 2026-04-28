import { jaccard, tokenSet } from './text.js';

const DEFAULT_ABSTAIN_THRESHOLD = 0.4;

export function scoreProbe(probe, recalls, options = {}) {
  const expectedIds = new Set(probe.expected ?? []);
  const forbiddenIds = new Set(probe.forbidden ?? []);
  const topK = probe.topK ?? options.topK ?? 5;
  const top = recalls.slice(0, topK);
  const returnedIds = top.map((item) => item.id);

  const matched = returnedIds.filter((id) => expectedIds.has(id));
  const forbidden = returnedIds.filter((id) => forbiddenIds.has(id));
  const precision = top.length === 0 ? 0 : matched.length / top.length;
  const recall = expectedIds.size === 0 ? 1 : matched.length / expectedIds.size;
  const hitRate = matched.length > 0 ? 1 : 0;
  const mrr = reciprocalRank(returnedIds, expectedIds);
  const ndcg = normalizedDiscountedGain(returnedIds, expectedIds, topK);
  const answerQuality = scoreAnswer(probe, top);
  const contaminationPenalty = forbidden.length === 0 ? 0 : Math.min(1, forbidden.length / Math.max(1, top.length));

  if ((probe.kind ?? 'recall') === 'abstention') {
    return scoreAbstention({ probe, top, expectedIds, forbidden, contaminationPenalty });
  }

  const score = clamp01(
    hitRate * 0.28 +
    recall * 0.22 +
    precision * 0.16 +
    mrr * 0.16 +
    ndcg * 0.1 +
    answerQuality * 0.08 -
    contaminationPenalty * 0.28
  );

  return {
    kind: probe.kind ?? 'recall',
    score,
    hitRate,
    precision,
    recall,
    mrr,
    ndcg,
    answerQuality,
    contaminationPenalty,
    matched,
    forbidden,
    returned: returnedIds
  };
}

function scoreAbstention({ probe, top, expectedIds, forbidden }) {
  const threshold = Number(probe.abstainThreshold ?? DEFAULT_ABSTAIN_THRESHOLD);
  const forbiddenIds = new Set(probe.forbidden ?? []);
  const highConfidence = top.filter((item) => Number(item.score ?? 0) >= threshold);
  const highConfidenceForbidden = highConfidence.filter((item) => forbiddenIds.has(item.id));
  const matchedExpected = top.filter((item) => expectedIds.has(item.id));
  const expectedConfident = matchedExpected.some((item) => Number(item.score ?? 0) >= threshold);
  const abstained = highConfidence.length === 0;
  const correctAbstention = expectedIds.size === 0
    ? abstained && highConfidenceForbidden.length === 0
    : expectedConfident && highConfidenceForbidden.length === 0;
  const contaminationPenalty = highConfidence.length === 0
    ? 0
    : Math.min(1, highConfidenceForbidden.length / highConfidence.length);
  const score = clamp01((correctAbstention ? 1 : 0) - contaminationPenalty * 0.5);

  return {
    kind: 'abstention',
    score,
    hitRate: correctAbstention ? 1 : 0,
    precision: correctAbstention ? 1 : 0,
    recall: correctAbstention ? 1 : 0,
    mrr: correctAbstention ? 1 : 0,
    ndcg: correctAbstention ? 1 : 0,
    answerQuality: correctAbstention ? 1 : 0,
    contaminationPenalty,
    abstained,
    abstainThreshold: threshold,
    highConfidenceCount: highConfidence.length,
    highConfidenceForbiddenCount: highConfidenceForbidden.length,
    matched: matchedExpected.map((item) => item.id),
    forbidden,
    returned: top.map((item) => item.id)
  };
}

function reciprocalRank(returnedIds, expectedIds) {
  const index = returnedIds.findIndex((id) => expectedIds.has(id));
  return index === -1 ? 0 : 1 / (index + 1);
}

function normalizedDiscountedGain(returnedIds, expectedIds, topK) {
  let dcg = 0;
  for (let index = 0; index < Math.min(topK, returnedIds.length); index += 1) {
    if (expectedIds.has(returnedIds[index])) {
      dcg += 1 / Math.log2(index + 2);
    }
  }

  const idealHits = Math.min(topK, expectedIds.size);
  let ideal = 0;
  for (let index = 0; index < idealHits; index += 1) {
    ideal += 1 / Math.log2(index + 2);
  }

  return ideal === 0 ? 1 : dcg / ideal;
}

function scoreAnswer(probe, recalls) {
  if (!probe.answer && !probe.answerKeywords?.length) {
    return 1;
  }

  const recalledText = recalls.map((item) => item.content ?? '').join(' ');
  if (!recalledText.trim()) {
    return 0;
  }

  if (probe.answerKeywords?.length) {
    const recalled = tokenSet(recalledText);
    const hits = probe.answerKeywords.filter((keyword) => {
      const keywordTokens = tokenSet(keyword);
      for (const token of keywordTokens) {
        if (!recalled.has(token)) {
          return false;
        }
      }
      return true;
    }).length;
    return hits / probe.answerKeywords.length;
  }

  return jaccard(tokenSet(probe.answer), tokenSet(recalledText));
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

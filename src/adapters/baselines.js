import { clamp, cosineSimilarity, jaccard, termFrequency, tokenSet, tokenize } from '../text.js';

class InMemoryAdapter {
  constructor(name, options = {}) {
    this.name = name;
    this.options = options;
    this.records = [];
    this.sequence = 0;
  }

  get capabilities() {
    return ['memory_encode', 'memory_recall'];
  }

  async reset() {
    this.records = [];
    this.sequence = 0;
  }

  async observe(event) {
    const observedAtDay = Number(event.day ?? this.sequence);
    const tokens = tokenize(recordSearchText(event));
    this.records.push({
      ...event,
      id: event.id,
      content: event.content,
      observedAtDay,
      sequence: this.sequence,
      tokens,
      tokenSet: new Set(tokens),
      vector: termFrequency(tokens),
      tags: event.tags ?? [],
      context: event.context ?? {},
      salience: Number(event.salience ?? 0.5)
    });
    this.sequence += 1;
  }

  async close() {}
}

export class StatelessAdapter extends InMemoryAdapter {
  constructor() {
    super('stateless');
  }

  async observe() {}

  async recall() {
    return [];
  }
}

export class EpisodicAdapter extends InMemoryAdapter {
  constructor(options = {}) {
    super('episodic', options);
  }

  async recall(query, options = {}) {
    const querySet = tokenSet(query);
    const currentDay = maxObservedDay(this.records);

    return this.records
      .map((record) => {
        const lexical = jaccard(querySet, record.tokenSet);
        const recency = 1 / (1 + Math.max(0, currentDay - record.observedAtDay));
        const score = lexical * 0.72 + recency * 0.18 + record.salience * 0.1 + tagBoost(record, options) + contextBoost(record, options);
        return resultFromRecord(record, score, { lexical, recency });
      })
      .filter((result) => result.score > 0.01)
      .sort(sortResults)
      .slice(0, options.limit ?? 10);
  }
}

export class SemanticAdapter extends InMemoryAdapter {
  constructor(options = {}) {
    super('semantic', options);
  }

  async recall(query, options = {}) {
    const queryVector = termFrequency(tokenize(query));
    const idf = inverseDocumentFrequency(this.records);
    const weightedQuery = weightVector(queryVector, idf);

    return this.records
      .map((record) => {
        const semantic = cosineSimilarity(weightedQuery, weightVector(record.vector, idf));
        const score = semantic * 0.86 + record.salience * 0.08 + tagBoost(record, options) + contextBoost(record, options);
        return resultFromRecord(record, score, { semantic });
      })
      .filter((result) => result.score > 0.01)
      .sort(sortResults)
      .slice(0, options.limit ?? 10);
  }
}

export class TypedSemanticAdapter extends SemanticAdapter {
  constructor(options = {}) {
    super(options);
    this.name = 'typed-semantic';
    this.currentBeliefs = new Map();
  }

  async reset() {
    await super.reset();
    this.currentBeliefs = new Map();
  }

  async observe(event) {
    await super.observe(event);
    if (event.entity && event.key) {
      const beliefKey = `${event.entity.toLowerCase()}::${event.key.toLowerCase()}`;
      this.currentBeliefs.set(beliefKey, event.id);
    }
  }

  async recall(query, options = {}) {
    const queryTokens = tokenSet(query);
    const base = await super.recall(query, { ...options, limit: this.records.length || 10 });

    return base
      .map((result) => {
        const record = this.records.find((candidate) => candidate.id === result.id);
        if (!record) {
          return result;
        }
        let boost = 0;
        if (options.type && record.type === options.type) {
          boost += 0.1;
        }
        if (record.entity && queryTokens.has(String(record.entity).toLowerCase())) {
          boost += 0.12;
        }
        if (record.key && queryTokens.has(String(record.key).toLowerCase())) {
          boost += 0.12;
        }
        if (record.entity && record.key) {
          const beliefKey = `${record.entity.toLowerCase()}::${record.key.toLowerCase()}`;
          boost += this.currentBeliefs.get(beliefKey) === record.id ? 0.18 : -0.12;
        }
        return { ...result, score: clamp(result.score + boost), diagnostics: { ...result.diagnostics, typedBoost: boost } };
      })
      .filter((result) => result.score > 0.01)
      .sort(sortResults)
      .slice(0, options.limit ?? 10);
  }
}

export class DecayedAdapter extends SemanticAdapter {
  constructor(options = {}) {
    super(options);
    this.name = 'decayed';
    this.halfLifeDays = options.halfLifeDays ?? 10;
  }

  async recall(query, options = {}) {
    const currentDay = maxObservedDay(this.records);
    const base = await super.recall(query, { ...options, limit: this.records.length || 10 });

    return base
      .map((result) => {
        const record = this.records.find((candidate) => candidate.id === result.id);
        const age = Math.max(0, currentDay - (record?.observedAtDay ?? currentDay));
        const decay = Math.pow(0.5, age / this.halfLifeDays);
        const salienceProtection = 0.35 + (record?.salience ?? 0.5) * 0.65;
        const decayedScore = result.score * decay * salienceProtection;
        return { ...result, score: decayedScore, diagnostics: { ...result.diagnostics, decay, age } };
      })
      .filter((result) => result.score > 0.01)
      .sort(sortResults)
      .slice(0, options.limit ?? 10);
  }
}

export class HybridAdapter extends TypedSemanticAdapter {
  constructor(options = {}) {
    super(options);
    this.name = 'hybrid';
  }

  async recall(query, options = {}) {
    const queryTokens = tokenSet(query);
    const queryVector = termFrequency(tokenize(query));
    const idf = inverseDocumentFrequency(this.records);
    const weightedQuery = weightVector(queryVector, idf);
    const currentDay = maxObservedDay(this.records);

    return this.records
      .map((record) => {
        const semantic = cosineSimilarity(weightedQuery, weightVector(record.vector, idf));
        const lexical = jaccard(queryTokens, record.tokenSet);
        const recency = 1 / (1 + Math.max(0, currentDay - record.observedAtDay));
        const typed = typedSignal(record, queryTokens, this.currentBeliefs, options);
        const score = clamp(
          semantic * 0.46 +
          lexical * 0.22 +
          typed * 0.2 +
          recency * 0.06 +
          record.salience * 0.06 +
          tagBoost(record, options) +
          contextBoost(record, options)
        );
        return resultFromRecord(record, score, { semantic, lexical, recency, typed });
      })
      .filter((result) => result.score > 0.01)
      .sort(sortResults)
      .slice(0, options.limit ?? 10);
  }
}

export function listAdapters() {
  return ['stateless', 'episodic', 'semantic', 'typed-semantic', 'decayed', 'hybrid'];
}

export function createAdapter(name, options = {}) {
  switch (name) {
    case 'stateless':
      return new StatelessAdapter(options);
    case 'episodic':
      return new EpisodicAdapter(options);
    case 'semantic':
      return new SemanticAdapter(options);
    case 'typed-semantic':
      return new TypedSemanticAdapter(options);
    case 'decayed':
      return new DecayedAdapter(options);
    case 'hybrid':
      return new HybridAdapter(options);
    default:
      throw new Error(`Unknown adapter: ${name}`);
  }
}

function recordSearchText(record) {
  return [
    record.content,
    record.entity,
    record.key,
    record.value,
    ...(record.tags ?? []),
    ...Object.values(record.context ?? {})
  ].filter(Boolean).join(' ');
}

function inverseDocumentFrequency(records) {
  const documentCounts = new Map();
  for (const record of records) {
    for (const token of record.tokenSet) {
      documentCounts.set(token, (documentCounts.get(token) ?? 0) + 1);
    }
  }
  const idf = new Map();
  for (const [token, count] of documentCounts.entries()) {
    idf.set(token, Math.log(1 + records.length / (1 + count)) + 1);
  }
  return idf;
}

function weightVector(vector, idf) {
  const weighted = new Map();
  for (const [token, count] of vector.entries()) {
    weighted.set(token, count * (idf.get(token) ?? 1));
  }
  return weighted;
}

function resultFromRecord(record, score, diagnostics = {}) {
  return {
    id: record.id,
    content: record.content,
    score: clamp(score),
    type: record.type,
    tags: record.tags,
    context: record.context,
    diagnostics
  };
}

function sortResults(left, right) {
  return right.score - left.score || String(left.id).localeCompare(String(right.id));
}

function maxObservedDay(records) {
  return records.reduce((max, record) => Math.max(max, record.observedAtDay ?? 0), 0);
}

function tagBoost(record, options) {
  const requiredTags = options.tags ?? [];
  if (requiredTags.length === 0) {
    return 0;
  }
  const tagSet = new Set(record.tags ?? []);
  const matches = requiredTags.filter((tag) => tagSet.has(tag)).length;
  return matches === 0 ? -0.08 : 0.05 * matches;
}

function contextBoost(record, options) {
  const context = options.context ?? {};
  const entries = Object.entries(context);
  if (entries.length === 0) {
    return 0;
  }
  let matches = 0;
  for (const [key, value] of entries) {
    if (String(record.context?.[key] ?? '').toLowerCase() === String(value).toLowerCase()) {
      matches += 1;
    }
  }
  return matches === 0 ? -0.05 : 0.06 * matches;
}

function typedSignal(record, queryTokens, currentBeliefs, options) {
  let signal = 0;
  if (options.type && record.type === options.type) {
    signal += 0.2;
  }
  if (record.entity && queryTokens.has(String(record.entity).toLowerCase())) {
    signal += 0.25;
  }
  if (record.key && queryTokens.has(String(record.key).toLowerCase())) {
    signal += 0.2;
  }
  if (record.entity && record.key) {
    const beliefKey = `${record.entity.toLowerCase()}::${record.key.toLowerCase()}`;
    signal += currentBeliefs.get(beliefKey) === record.id ? 0.35 : -0.15;
  }
  return clamp(signal, 0, 1);
}

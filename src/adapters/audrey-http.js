import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { resolveAudreyConfig, resolveDataDir, sanitizePathPart } from './audrey-mcp.js';
import { buildChildEnv } from '../env.js';
import { normalizeContext } from '../text.js';

export class AudreyHttpAdapter {
  constructor(options = {}, runtime = {}) {
    this.name = 'audrey-http';
    this.kind = 'external';
    this.options = options;
    this.runId = runtime.runId ?? `mg-${Date.now()}`;
    this.server = null;
    this.generatedIds = new Map();
    this.baseUrl = null;
    this.apiKey = options.apiKey ?? '';
    this.scenarioId = 'suite';
    this.dataDir = null;
  }

  get capabilities() {
    return ['memory_encode', 'memory_recall'];
  }

  async reset(scenario = {}) {
    this.scenarioId = sanitizePathPart(scenario.id ?? 'suite');
    this.generatedIds = new Map();
    const persistent = this.options.persistentChild !== false;

    if (!persistent) {
      await this.close();
    }

    if (!this.dataDir) {
      this.dataDir = resolveDataDir(
        this.options,
        this.runId,
        persistent ? 'shared' : this.scenarioId,
        'audrey-http-runs'
      );
      await mkdir(this.dataDir, { recursive: true });
    }
    if (!this.baseUrl) {
      this.baseUrl = this.options.baseUrl
        ? validateAudreyHttpBaseUrl(this.options.baseUrl, { allowRemoteAudrey: Boolean(this.options.allowRemoteAudrey) })
        : null;
    }

    if (persistent) {
      await this.ensureStarted();
    }
  }

  async observe(event) {
    await this.ensureStarted();
    const result = await this.request('/v1/encode', {
      content: `[MemoryGym:${event.id}] ${event.content}`,
      source: normalizeSource(event.source),
      tags: [...new Set(['memorygym', this.runId, this.scenarioId, ...(event.tags ?? [])])],
      salience: Number(event.salience ?? 0.7),
      context: normalizeContext({
        ...event.context,
        memorygym_run: this.runId,
        memorygym_scenario: this.scenarioId,
        memorygym_event_id: event.id,
        memorygym_type: event.type
      })
    });
    if (result?.id) {
      this.generatedIds.set(result.id, event.id);
    }
  }

  async recall(query, options = {}) {
    await this.ensureStarted();
    const results = await this.request('/v1/recall', {
      query,
      limit: Math.min(50, Math.max(1, options.limit ?? 10)),
      tags: ['memorygym', this.runId, this.scenarioId],
      context: normalizeContext({
        ...(options.context ?? {}),
        memorygym_run: this.runId,
        memorygym_scenario: this.scenarioId
      })
    });
    return (Array.isArray(results) ? results : []).map((item) => this.normalizeRecall(item));
  }

  async status() {
    await this.ensureStarted();
    return this.get('/v1/status');
  }

  async close() {
    if (!this.server) {
      return;
    }
    const child = this.server;
    this.server = null;
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
    try {
      await once(child, 'exit');
    } catch {
      child.kill('SIGKILL');
    } finally {
      clearTimeout(timer);
    }
  }

  async ensureStarted() {
    if (this.baseUrl) {
      await this.waitForHealthy();
      return;
    }

    const config = await resolveAudreyConfig(this.options);
    const port = Number(this.options.port ?? 7437);
    this.baseUrl = `http://127.0.0.1:${port}`;

    try {
      this.server = spawn(config.command, [...config.args, 'serve'], {
        env: buildChildEnv({
          ...config.env,
          AUDREY_AGENT: this.options.agent ?? 'memorygym-http',
          AUDREY_DATA_DIR: this.dataDir,
          AUDREY_PORT: String(port),
          AUDREY_API_KEY: this.apiKey,
          AUDREY_EMBEDDING_PROVIDER: this.options.embeddingProvider ?? config.env.AUDREY_EMBEDDING_PROVIDER ?? 'mock',
          AUDREY_LLM_PROVIDER: this.options.llmProvider ?? config.env.AUDREY_LLM_PROVIDER ?? 'mock',
          AUDREY_DEVICE: this.options.device ?? config.env.AUDREY_DEVICE ?? 'cpu'
        }),
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true
      });
    } catch (error) {
      if (error?.code === 'EPERM') {
        throw new Error(`Unable to spawn Audrey HTTP server due to host process restrictions: ${config.command}. Start Audrey separately and pass --audrey-http-base-url.`);
      }
      throw error;
    }

    let stderr = '';
    this.server.stderr.setEncoding('utf8');
    this.server.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (stderr.length > 12000) {
        stderr = stderr.slice(-12000);
      }
    });
    this.server.once('exit', (code, signal) => {
      if (this.server) {
        this.server = null;
        console.error(`[memorygym] Audrey HTTP server exited code=${code} signal=${signal}${stderr ? ` stderr=${stderr.trim()}` : ''}`);
      }
    });

    await this.waitForHealthy();
  }

  async waitForHealthy() {
    const timeoutMs = this.options.startupTimeoutMs ?? 60000;
    const startedAt = Date.now();
    let lastError;
    while (Date.now() - startedAt < timeoutMs) {
      try {
        await this.get('/health');
        return;
      } catch (error) {
        lastError = error;
        await sleep(250);
      }
    }
    throw new Error(`Audrey HTTP server did not become healthy: ${lastError?.message ?? 'unknown error'}`);
  }

  async get(path) {
    const response = await fetch(new URL(path, this.baseUrl), {
      headers: this.headers()
    });
    return parseResponse(response);
  }

  async request(path, body) {
    const response = await fetch(new URL(path, this.baseUrl), {
      method: 'POST',
      headers: {
        ...this.headers(),
        'content-type': 'application/json'
      },
      body: JSON.stringify(body)
    });
    return parseResponse(response);
  }

  headers() {
    return this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {};
  }

  normalizeRecall(item) {
    const id = this.generatedIds.get(item.id) ?? extractMemoryGymId(item.content) ?? item.id;
    return {
      id,
      audreyId: item.id,
      content: stripMemoryGymPrefix(item.content),
      score: Number(item.score ?? item.confidence ?? 0),
      type: item.type,
      diagnostics: {
        confidence: item.confidence,
        contextMatch: item.contextMatch,
        moodCongruence: item.moodCongruence,
        lexicalCoverage: item.lexicalCoverage,
        createdAt: item.createdAt,
        state: item.state
      }
    };
  }
}

export function validateAudreyHttpBaseUrl(baseUrl, options = {}) {
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(`Invalid Audrey HTTP base URL: ${baseUrl}`);
  }

  const isLocal = parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]', '::1'].includes(parsed.hostname);
  if (!isLocal && !options.allowRemoteAudrey) {
    throw new Error('Refusing remote Audrey HTTP base URL without --allow-remote-audrey');
  }
  return parsed.href.replace(/\/$/, '');
}

async function parseResponse(response) {
  const text = await response.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${typeof parsed === 'string' ? parsed : JSON.stringify(parsed)}`);
  }
  return parsed;
}

function normalizeSource(source) {
  const valid = new Set(['direct-observation', 'told-by-user', 'tool-result', 'inference', 'model-generated']);
  return valid.has(source) ? source : 'direct-observation';
}

function extractMemoryGymId(content = '') {
  return String(content).match(/^\[MemoryGym:([^\]]+)]/)?.[1];
}

function stripMemoryGymPrefix(content = '') {
  return String(content).replace(/^\[MemoryGym:[^\]]+]\s*/, '');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

import { existsSync, realpathSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path, { join, resolve } from 'node:path';
import { McpStdioClient } from '../mcp/stdio-client.js';
import { normalizeContext } from '../text.js';

const DEFAULT_CONFIG_PATH = join(homedir(), '.codex', 'config.toml');
const DEFAULT_AUDREY_ENTRYPOINT = 'B:\\projects\\claude\\audrey\\dist\\mcp-server\\index.js';
const DEFAULT_NODE_COMMAND = 'C:\\Program Files\\nodejs\\node.exe';

export class AudreyMcpAdapter {
  constructor(options = {}, runtime = {}) {
    this.name = 'audrey-mcp';
    this.kind = 'external';
    this.options = options;
    this.runId = runtime.runId ?? `mg-${Date.now()}`;
    this.client = null;
    this.generatedIds = new Map();
    this.dataDir = null;
    this.scenarioId = 'suite';
    this.config = null;
    this.discoveredCapabilities = null;
    this.persistentChild = options.persistentChild !== false;
  }

  get capabilities() {
    return this.discoveredCapabilities ?? ['memory_encode', 'memory_recall'];
  }

  async reset(scenario = {}) {
    this.scenarioId = sanitizePathPart(scenario.id ?? 'suite');
    this.generatedIds = new Map();

    if (!this.persistentChild) {
      await this.close();
    }

    if (!this.config) {
      this.config = await resolveAudreyConfig(this.options);
    }
    if (!this.dataDir) {
      this.dataDir = resolveDataDir(
        this.options,
        this.runId,
        this.persistentChild ? 'shared' : this.scenarioId
      );
      await mkdir(this.dataDir, { recursive: true });
    }

    if (this.persistentChild) {
      await this.ensureStarted();
      await this.warmup();
    }
  }

  async warmup() {
    if (!this.client) {
      return;
    }
    try {
      await this.client.callTool('memory_status', {});
    } catch (error) {
      console.warn(`[memorygym] audrey-mcp warmup skipped: ${error?.message ?? error}`);
    }
  }

  async observe(event) {
    await this.ensureStarted();
    if (event.audreyToolCall) {
      await this.callNativeTool(event.audreyToolCall);
      return;
    }

    const payload = {
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
    };

    const result = await this.client.callTool('memory_encode', payload);
    if (result?.id) {
      this.generatedIds.set(result.id, event.id);
    }
  }

  async recall(query, options = {}) {
    await this.ensureStarted();
    const payload = {
      query,
      limit: Math.min(50, Math.max(1, options.limit ?? 10)),
      tags: ['memorygym', this.runId, this.scenarioId],
      context: normalizeContext({
        ...(options.context ?? {}),
        memorygym_run: this.runId,
        memorygym_scenario: this.scenarioId
      })
    };

    const raw = await this.client.callTool('memory_recall', payload);
    const results = Array.isArray(raw) ? raw : [];
    return results.map((item) => this.normalizeRecall(item));
  }

  async status() {
    await this.ensureStarted();
    return this.client.callTool('memory_status', {});
  }

  async discoverCapabilities() {
    await this.ensureStarted();
    const response = await this.client.request('tools/list', {});
    const tools = Array.isArray(response?.tools) ? response.tools : [];
    this.discoveredCapabilities = tools.map((tool) => tool.name).filter(Boolean);
    return this.capabilities;
  }

  async runCapabilityProbe(probe) {
    await this.ensureStarted();
    const diagnostics = {};
    for (const capability of probe.requires ?? []) {
      const args = probe.capabilityArgs?.[capability] ?? defaultCapabilityArgs(capability, probe);
      const result = await this.client.callTool(capability, args);
      diagnostics[capability] = summarizeNativeResult(result);
    }
    return diagnostics;
  }

  async prepareProbe(probe) {
    if (!probe.capabilityArgs) {
      return null;
    }
    await this.ensureStarted();
    const diagnostics = {};
    for (const capability of probe.requires ?? []) {
      if (!probe.capabilityArgs[capability]) {
        continue;
      }
      const result = await this.client.callTool(capability, probe.capabilityArgs[capability]);
      diagnostics[capability] = summarizeNativeResult(result);
    }
    return diagnostics;
  }

  async close() {
    if (this.client) {
      await this.client.close();
      this.client = null;
    }
  }

  async ensureStarted() {
    if (this.client) {
      return;
    }
    if (!this.config) {
      await this.reset({ id: this.scenarioId });
    }

    this.client = new McpStdioClient({
      command: this.config.command,
      args: this.config.args,
      env: {
        ...this.config.env,
        AUDREY_AGENT: this.options.agent ?? 'memorygym',
        AUDREY_DATA_DIR: this.dataDir,
        AUDREY_EMBEDDING_PROVIDER: this.options.embeddingProvider ?? this.config.env.AUDREY_EMBEDDING_PROVIDER ?? 'mock',
        AUDREY_LLM_PROVIDER: this.options.llmProvider ?? this.config.env.AUDREY_LLM_PROVIDER ?? 'mock',
        AUDREY_DEVICE: this.options.device ?? this.config.env.AUDREY_DEVICE ?? 'cpu'
      },
      startupTimeoutMs: this.options.startupTimeoutMs ?? 60000,
      requestTimeoutMs: this.options.requestTimeoutMs ?? 60000
    });
    await this.client.start();
  }

  async callNativeTool(toolCall) {
    if (!toolCall?.name) {
      throw new Error('Audrey native tool event is missing tool name');
    }
    const result = await this.client.callTool(toolCall.name, toolCall.arguments ?? {});
    if (toolCall.mapIdFrom && result?.[toolCall.mapIdFrom]) {
      this.generatedIds.set(result[toolCall.mapIdFrom], toolCall.memorygymEventId ?? toolCall.name);
    }
    return result;
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

function defaultCapabilityArgs(capability, probe) {
  switch (capability) {
    case 'memory_dream':
      return {
        min_cluster_size: 2,
        similarity_threshold: 0.55,
        dormant_threshold: 0.1
      };
    case 'memory_observe_tool':
      return {
        event: 'PostToolUseFailure',
        tool: 'Bash',
        session_id: `memorygym-${probe.id}`,
        input: { command: probe.query },
        output: { stderr: 'Synthetic MemoryGym capability probe failure' },
        outcome: 'failed',
        error_summary: probe.query,
        cwd: process.cwd(),
        retain_details: false
      };
    case 'memory_preflight':
      return {
        action: probe.query,
        tool: 'Bash',
        strict: true,
        limit: probe.topK ?? 5,
        include_capsule: false,
        record_event: false
      };
    case 'memory_reflexes':
      return {
        action: probe.query,
        tool: 'Bash',
        strict: true,
        limit: probe.topK ?? 5,
        include_capsule: false,
        include_preflight: false,
        record_event: false
      };
    default:
      return {};
  }
}

function summarizeNativeResult(result) {
  if (Array.isArray(result)) {
    return { type: 'array', length: result.length };
  }
  if (result && typeof result === 'object') {
    return {
      type: 'object',
      keys: Object.keys(result).slice(0, 12)
    };
  }
  return {
    type: typeof result,
    value: result
  };
}

export async function resolveAudreyConfig(options = {}) {
  const configPath = resolve(options.configPath ?? DEFAULT_CONFIG_PATH);
  if (options.configPath && !existsSync(configPath)) {
    throw new Error(`Audrey MCP config not found: ${configPath}`);
  }
  const parsed = existsSync(configPath) ? parseAudreyFromCodexConfig(await readFile(configPath, 'utf8')) : {};
  const command = options.command ?? parsed.command ?? DEFAULT_NODE_COMMAND;
  const args = options.args ?? parsed.args ?? [DEFAULT_AUDREY_ENTRYPOINT];
  const env = {
    ...(parsed.env ?? {}),
    ...(options.env ?? {})
  };

  if (!command) {
    throw new Error('Audrey MCP command is missing');
  }
  if (!Array.isArray(args) || args.length === 0) {
    throw new Error('Audrey MCP args are missing');
  }
  validateAudreyCommand(command, args, {
    allowArbitraryCommand: Boolean(options.allowArbitraryCommand)
  });

  return { command, args, env, configPath };
}

export function validateAudreyCommand(command, args = [], options = {}) {
  if (options.allowArbitraryCommand) {
    return true;
  }
  if (isNodeCommand(command) || isConfiguredAudreyEntrypoint(command, args)) {
    return true;
  }
  throw new Error(`Refusing to launch Audrey MCP command "${command}". Use node/node.exe or pass --allow-arbitrary-audrey-command for a trusted local command.`);
}

function parseAudreyFromCodexConfig(text) {
  const lines = text.split(/\r?\n/);
  let section = '';
  const server = {};
  const env = {};

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const sectionMatch = line.match(/^\[(.+)]$/);
    if (sectionMatch) {
      section = sectionMatch[1];
      continue;
    }
    const assignment = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (!assignment) {
      continue;
    }
    const [, key, rawValue] = assignment;
    if (section === 'mcp_servers.audrey-memory') {
      server[key] = parseTomlLiteValue(rawValue);
    } else if (section === 'mcp_servers.audrey-memory.env') {
      env[key] = String(parseTomlLiteValue(rawValue));
    }
  }

  return {
    command: server.command,
    args: server.args,
    env
  };
}

function parseTomlLiteValue(rawValue) {
  const trimmed = rawValue.trim();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const body = trimmed.slice(1, -1).trim();
    if (!body) {
      return [];
    }
    return splitTomlArrayItems(body).map(parseTomlLiteValue);
  }
  const quote = trimmed[0];
  if ((quote === '"' || quote === "'") && trimmed.endsWith(quote)) {
    return quote === '"' ? unescapeTomlBasicString(trimmed.slice(1, -1)) : trimmed.slice(1, -1);
  }
  if (trimmed === 'true') {
    return true;
  }
  if (trimmed === 'false') {
    return false;
  }
  const number = Number(trimmed);
  return Number.isFinite(number) ? number : trimmed;
}

function splitTomlArrayItems(body) {
  const items = [];
  let current = '';
  let quote = null;
  let escaped = false;

  for (const char of body) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (quote === '"' && char === '\\') {
      current += char;
      escaped = true;
      continue;
    }
    if ((char === '"' || char === "'") && !quote) {
      quote = char;
      current += char;
      continue;
    }
    if (char === quote) {
      quote = null;
      current += char;
      continue;
    }
    if (char === ',' && !quote) {
      items.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }

  if (quote) {
    throw new Error('Unsupported TOML array value: unterminated quoted string');
  }
  if (current.trim()) {
    items.push(current.trim());
  }
  return items;
}

function unescapeTomlBasicString(value) {
  return value.replace(/\\([btnfr"\\])/g, (_, char) => {
    switch (char) {
      case 'b':
        return '\b';
      case 't':
        return '\t';
      case 'n':
        return '\n';
      case 'f':
        return '\f';
      case 'r':
        return '\r';
      default:
        return char;
    }
  });
}

export function resolveDataDir(options, runId, scenarioId, root = 'audrey-runs') {
  if (options.dataDir) {
    const explicit = resolve(options.dataDir);
    const liveDir = join(homedir(), '.audrey', 'data');
    if (!options.allowLiveData && isWithinOrSamePath(realpathBestEffort(liveDir), realpathBestEffort(explicit))) {
      throw new Error('Refusing to run benchmarks against the live Audrey data dir without allowLiveData=true');
    }
    return explicit;
  }
  return resolve('.memorygym', root, sanitizePathPart(runId), sanitizePathPart(scenarioId));
}

export function isWithinOrSamePath(parent, child, pathApi = path) {
  const relativePath = pathApi.relative(parent, child);
  return relativePath === '' || (!relativePath.startsWith('..') && !pathApi.isAbsolute(relativePath));
}

function realpathBestEffort(target) {
  const resolved = resolve(target);
  if (existsSync(resolved)) {
    return realpathSync(resolved);
  }

  const missingParts = [];
  let current = resolved;
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) {
      return resolved;
    }
    missingParts.unshift(path.basename(current));
    current = parent;
  }
  return join(realpathSync(current), ...missingParts);
}

function isNodeCommand(command) {
  const basename = path.basename(String(command)).toLowerCase();
  return basename === 'node' || basename === 'node.exe';
}

function isConfiguredAudreyEntrypoint(command, args) {
  const commandPath = normalizePathForCompare(command);
  const candidates = [DEFAULT_AUDREY_ENTRYPOINT, ...(Array.isArray(args) ? args : [])]
    .filter(looksLikeAudreyEntrypoint)
    .map(normalizePathForCompare);
  return candidates.some((candidate) => commandPath === candidate || commandPath.endsWith(`/${candidate.split('/').slice(-4).join('/')}`));
}

function looksLikeAudreyEntrypoint(value) {
  const normalized = normalizePathForCompare(value);
  return normalized.endsWith('/dist/mcp-server/index.js') && normalized.includes('/audrey/');
}

function normalizePathForCompare(value) {
  return String(value).replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase();
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

export function sanitizePathPart(value) {
  return String(value).replace(/[^a-zA-Z0-9_.-]+/g, '_').slice(0, 90) || 'default';
}

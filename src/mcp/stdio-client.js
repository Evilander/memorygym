import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { buildChildEnv } from '../env.js';

const MAX_STDOUT_BUFFER_CHARS = 4 * 1024 * 1024;

export class McpStdioClient {
  constructor({ command, args = [], env = {}, startupTimeoutMs = 30000, requestTimeoutMs = 30000 }) {
    this.command = command;
    this.args = args;
    this.env = env;
    this.startupTimeoutMs = startupTimeoutMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = '';
    this.stderr = '';
    this.process = null;
    this.initialized = false;
  }

  async start() {
    if (this.process) {
      return;
    }

    try {
      this.process = spawn(this.command, this.args, {
        env: buildChildEnv(this.env),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      });
    } catch (error) {
      if (error?.code === 'EPERM') {
        throw new Error(`Unable to spawn MCP server due to host process restrictions: ${this.command}. Run the same command from a normal shell or use MemoryGym's reports without external adapters in this sandbox.`);
      }
      throw error;
    }

    this.process.stdout.setEncoding('utf8');
    this.process.stderr.setEncoding('utf8');

    this.process.stdout.on('data', (chunk) => this.handleStdout(chunk));
    this.process.stderr.on('data', (chunk) => {
      this.stderr += chunk;
      if (this.stderr.length > 12000) {
        this.stderr = this.stderr.slice(-12000);
      }
    });
    this.process.once('exit', (code, signal) => {
      const error = new Error(`MCP server exited code=${code} signal=${signal}${this.stderr ? ` stderr=${this.stderr.trim()}` : ''}`);
      this.rejectPending(error);
      this.process = null;
      this.initialized = false;
    });
    this.process.once('error', (error) => {
      this.rejectPending(error);
    });

    await this.initialize();
  }

  async initialize() {
    if (this.initialized) {
      return;
    }

    await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: {
        name: 'memorygym',
        version: '0.1.0'
      }
    }, this.startupTimeoutMs);

    this.notify('notifications/initialized', {});
    this.initialized = true;
  }

  async callTool(name, args = {}) {
    const response = await this.request('tools/call', { name, arguments: args });
    if (response?.isError) {
      const message = response.content?.map((item) => item.text).join('\n') || `Tool ${name} failed`;
      throw new Error(message);
    }
    return parseToolPayload(response);
  }

  request(method, params = {}, timeoutMs = this.requestTimeoutMs) {
    if (!this.process?.stdin.writable) {
      throw new Error('MCP server is not running');
    }

    const id = this.nextId;
    this.nextId += 1;
    const message = { jsonrpc: '2.0', id, method, params };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timeout, method });
      this.process.stdin.write(`${JSON.stringify(message)}\n`);
    });
  }

  notify(method, params = {}) {
    if (!this.process?.stdin.writable) {
      return;
    }
    this.process.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  async close() {
    const child = this.process;
    if (!child) {
      return;
    }

    this.process = null;
    child.stdin.end();
    child.kill('SIGTERM');

    const timer = setTimeout(() => {
      if (!child.killed) {
        child.kill('SIGKILL');
      }
    }, 2000);

    try {
      await once(child, 'exit');
    } catch {
      child.kill('SIGKILL');
    } finally {
      clearTimeout(timer);
    }
  }

  handleStdout(chunk) {
    this.buffer += chunk;
    if (this.buffer.length > MAX_STDOUT_BUFFER_CHARS) {
      const error = new Error('MCP stdout buffer exceeded 4MB; terminating child process');
      this.stderr += `\n${error.message}`;
      this.rejectPending(error);
      this.buffer = '';
      this.process?.kill?.('SIGKILL');
      return;
    }
    while (true) {
      const index = this.buffer.indexOf('\n');
      if (index === -1) {
        return;
      }
      const line = this.buffer.slice(0, index).replace(/\r$/, '');
      this.buffer = this.buffer.slice(index + 1);
      if (!line.trim()) {
        continue;
      }
      this.handleMessage(line);
    }
  }

  handleMessage(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.stderr += `\n[stdout-non-json] ${line}`;
      return;
    }

    if (message.id === undefined) {
      return;
    }

    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }
    this.pending.delete(message.id);
    clearTimeout(pending.timeout);

    if (message.error) {
      pending.reject(new Error(`${pending.method} failed: ${message.error.message ?? JSON.stringify(message.error)}`));
      return;
    }

    pending.resolve(message.result);
  }

  rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function parseToolPayload(response) {
  const textBlocks = response?.content?.filter((item) => item.type === 'text').map((item) => item.text) ?? [];
  if (textBlocks.length === 0) {
    return response;
  }

  const text = textBlocks.join('\n');
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

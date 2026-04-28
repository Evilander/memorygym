import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { listAdapters } from './adapters/baselines.js';
import { resolveAudreyConfig } from './adapters/audrey-mcp.js';

const DEFAULT_CODEX_CONFIG_PATH = join(homedir(), '.codex', 'config.toml');

export async function inspectMemoryGym(options = {}) {
  const audrey = await inspectAudrey(options.audrey ?? {});
  return {
    node: process.version,
    cwd: process.cwd(),
    adapters: {
      local: listAdapters(),
      external: ['audrey-mcp', 'audrey-http']
    },
    paths: {
      reports: resolve('reports'),
      artifacts: resolve('.memorygym')
    },
    audrey
  };
}

async function inspectAudrey(options) {
  try {
    const configPath = resolve(options.configPath ?? DEFAULT_CODEX_CONFIG_PATH);
    if (options.configPath && !existsSync(configPath)) {
      return {
        configured: false,
        configPath,
        error: `Audrey MCP config not found: ${configPath}`
      };
    }
    if (!options.command && !options.args && !existsSync(configPath)) {
      return {
        configured: false,
        configPath,
        error: 'No Audrey MCP config found'
      };
    }
    const config = await resolveAudreyConfig(options);
    const entrypoint = config.args[0];
    return {
      configured: true,
      configPath: config.configPath,
      command: config.command,
      entrypoint,
      commandExists: existsSync(config.command),
      entrypointExists: existsSync(entrypoint),
      dataDirMode: options.dataDir ? 'explicit' : 'isolated-by-default',
      liveDataGuard: !options.allowLiveData,
      envDefaults: {
        AUDREY_EMBEDDING_PROVIDER: config.env.AUDREY_EMBEDDING_PROVIDER ?? null,
        AUDREY_LLM_PROVIDER: config.env.AUDREY_LLM_PROVIDER ?? null,
        AUDREY_DEVICE: config.env.AUDREY_DEVICE ?? null
      }
    };
  } catch (error) {
    return {
      configured: false,
      error: error.message
    };
  }
}

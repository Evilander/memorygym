const SAFE_ENV_KEYS = new Set([
  'path',
  'home',
  'userprofile',
  'appdata',
  'localappdata',
  'systemroot',
  'windir',
  'temp',
  'tmp',
  'node_env'
]);

export function buildChildEnv(explicitEnv = {}, sourceEnv = process.env) {
  if (sourceEnv.MEMORYGYM_PASS_ENV === '1') {
    return { ...sourceEnv, ...explicitEnv };
  }

  const env = {};
  for (const [key, value] of Object.entries(sourceEnv)) {
    if (isSafeEnvKey(key)) {
      env[key] = value;
    }
  }
  return { ...env, ...explicitEnv };
}

export function isSafeEnvKey(key) {
  const normalized = String(key).toLowerCase();
  return SAFE_ENV_KEYS.has(normalized) || key.startsWith('AUDREY_') || key.startsWith('MEMORYGYM_');
}

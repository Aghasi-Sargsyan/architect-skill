// Stub for role model inspection and selection CLI (--models and --set-model).
export function extractEffort() {
  return null;
}

export function resolveArchitectModelInfo() {
  return { ok: false, model: null, source: null, detail: 'Not implemented' };
}

export async function listAvailableModels() {
  return { runner: 'agy', models: [] };
}

export function setRoleModel() {
  throw new Error('Not implemented');
}

export async function handleModelsCli() {
  throw new Error('Not implemented');
}

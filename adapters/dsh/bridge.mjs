import { readFileSync, lstatSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { WorkspaceConnector } from '../codex/connector.mjs';
// Frozen six-tool schemas are bundled assets: the extension has no dependency
// on the server, SQLite or Ajv, and can run outside the source checkout.
const definitions = JSON.parse(readFileSync(new URL('../codex/tools.json', import.meta.url), 'utf8'));

const failure = (code, message, nextAction) => Object.assign(new Error(message), { code, nextAction, retry: 'after_input', operationId: null });
export function readConnection(file) {
  try {
    if (!isAbsolute(file) || !lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) throw new Error();
    const config = JSON.parse(readFileSync(file, 'utf8'));
    if (!config || Object.keys(config).sort().join(',') !== 'endpoint,scope,tokenFile' ||
        typeof config.tokenFile !== 'string' || !isAbsolute(config.tokenFile)) throw new Error();
    return config;
  } catch {
    throw failure('capability_unavailable', '还没有连接这个项目。', '请使用当前项目的连接文件，并由维护人员检查连接地址、权限和所选项目。');
  }
}
export function createBridge(config) {
  if (!config || Object.keys(config).sort().join(',') !== 'endpoint,scope,tokenFile' ||
      typeof config.tokenFile !== 'string' || !isAbsolute(config.tokenFile)) {
    throw failure('validation_failed', '项目连接设置不完整或不正确。', '请由维护人员检查连接地址、连接文件和所选项目。');
  }
  const connector = new WorkspaceConnector(config);
  return {
    tools: definitions.map(tool => ({ ...tool, inputSchema: { ...tool.inputSchema,
      properties: { ...tool.inputSchema.properties, scope: { ...tool.inputSchema.properties.scope, const: connector.scope } } } })),
    async call(name, args, signal) {
      if (name === 'prepare_task' && (args?.mode !== 'host_assist' || args?.executor !== 'current_host')) {
        throw failure('validation_failed', '这个扩展只为当前使用的工具准备任务。', '请选择在当前工具中继续，不要从这个扩展启动其他工具。');
      }
      return connector.call(name, args, signal);
    },
  };
}

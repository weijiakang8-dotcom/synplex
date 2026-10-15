import { fileURLToPath } from 'node:url';
import { resolve, isAbsolute } from 'node:path';
import { readConnection } from './bridge.mjs';
export const name='synplex-workspace';
export const inject=['tools'];

// Official Cordis/MCP-client composition; the child owns only project-memory
// tools. Plugin disposal is delegated to Cordis, not to another running Agent.
export async function apply(ctx,config={}) {
  if(Object.keys(config).some(k=>k!=='connectionFile'))throw new Error('只能设置当前项目的连接文件。');
  const connectionFile=config.connectionFile??fileURLToPath(new URL('../../connection.json',import.meta.url));
  if(!isAbsolute(connectionFile))throw new Error('请提供项目连接文件的完整位置。');
  readConnection(connectionFile);
  const McpClient=await import('@deepseek-ai/dsh-mcp-client');
  await ctx.plugin(McpClient,{serverName:'synplex_workspace',transport:'stdio',command:process.execPath,
    args:[fileURLToPath(new URL('./mcp.mjs',import.meta.url)),resolve(connectionFile)],env:{},cwd:'',
    toolCallTimeoutMs:30_000,failOnStartupError:true,reconnect:{enabled:true,initialDelayMs:500,maxDelayMs:30_000,maxAttempts:10}});
}

#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { createBridge, readConnection } from './bridge.mjs';

const versions = ['2024-11-05', '2025-03-26', '2025-06-18'];
const limit = 2 * 1024 * 1024 + 4096;
export function startStdio({ input = process.stdin, output = process.stdout, connectionFile } = {}) {
  let bridge, initialized = false, version = versions.at(-1), pending = Buffer.alloc(0), dropping = false;
  const calls = new Map();
  const send = value => output.write(JSON.stringify(value) + '\n');
  const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
  const error = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });
  const client = () => bridge ??= createBridge(readConnection(connectionFile));
  function handle(line) {
    let message;
    try { message = JSON.parse(line.toString('utf8')); } catch { error(null, -32700, '提交内容的格式无法读取。'); return; }
    const validId = message && (typeof message.id === 'string' || Number.isFinite(message.id) || message.id === null);
    if (!message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0' ||
        typeof message.method !== 'string' || message.id !== undefined && !validId) {
      error(validId ? message.id : null, -32600, '提交内容不完整或格式不正确。'); return;
    }
    if (message.method === 'notifications/cancelled') { calls.get(message.params?.requestId)?.abort(); return; }
    if (message.id === undefined) return;
    const id = message.id;
    if (message.method === 'initialize') {
      initialized = true; version = versions.includes(message.params?.protocolVersion) ? message.params.protocolVersion : versions.at(-1);
      reply(id, { protocolVersion: version, capabilities: { tools: {} }, serverInfo: { name: 'synplex-dsh-bridge', version: '0.1.0' } }); return;
    }
    if (!initialized) { error(id, -32002, '请先连接项目，再使用这些功能。'); return; }
    if (message.method === 'ping') { reply(id, {}); return; }
    if (message.method === 'tools/list') {
      try { reply(id, { tools: client().tools }); } catch { error(id, -32603, '请先连接你的 Synplex 项目。'); }
      return;
    }
    if (message.method !== 'tools/call') { error(id, -32601, '没有这个操作，请选择可用功能。'); return; }
    if (calls.has(id)) { error(id, -32600, '这次提交正在处理，请先查看进度，不要重复提交。'); return; }
    const control = new AbortController(); calls.set(id, control);
    void (async () => {
      try {
        const value = await client().call(message.params?.name, message.params?.arguments ?? {}, control.signal);
        reply(id, { content: [{ type: 'text', text: JSON.stringify(value) }], ...(version === '2025-06-18' ? { structuredContent: value } : {}) });
      } catch (e) {
        const feedback = { code: e.code ?? 'capability_unavailable', message: e.code ? e.message : '项目暂时无法连接。',
          nextAction: e.nextAction ?? '请由维护人员检查当前项目的连接设置。', retry: e.retry ?? 'after_input', operationId: e.operationId ?? null };
        reply(id, { isError: true, content: [{ type: 'text', text: JSON.stringify(feedback) }] });
      } finally { calls.delete(id); }
    })();
  }
  // Bound buffering before a newline arrives, including a single oversized chunk.
  function data(chunk) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let start = 0;
    while (start < bytes.length) {
      const newline = bytes.indexOf(10, start), end = newline < 0 ? bytes.length : newline;
      const part = bytes.subarray(start, end);
      if (!dropping) {
        if (pending.length + part.length > limit) { pending = Buffer.alloc(0); dropping = true; error(null, -32600, '提交内容太大，请减少内容后再试。'); }
        else pending = Buffer.concat([pending, part]);
      }
      if (newline < 0) break;
      if (!dropping && pending.length) handle(pending);
      pending = Buffer.alloc(0); dropping = false; start = newline + 1;
    }
  }
  function close() { pending = Buffer.alloc(0); for (const control of calls.values()) control.abort(); }
  input.on('data', data); input.once('end', close);
  return () => { input.off('data', data); input.off('end', close); close(); };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startStdio({ connectionFile: process.argv[2] });
}

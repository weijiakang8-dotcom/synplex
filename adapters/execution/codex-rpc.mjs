import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';

export class CodexConnection extends EventEmitter {
  constructor(settings) {
    super();
    this.settings = settings;
    this.sequence = 0;
    this.pending = new Map();
    this.requests = new Map();
    this.stderr = '';
  }

  async connect() {
    if (this.proc) return;
    this.proc = spawn(this.settings.codexBinary, ['app-server', '--listen', 'stdio://'], {
      env: { ...process.env, CODEX_HOME: this.settings.runtimeHome },
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: this.settings.runtimeHome,
    });
    this.proc.on('error', error => this.fail(error));
    this.proc.on('exit', (code, signal) => {
      this.fail(new Error(`Codex 连接已关闭（${signal || code}）`));
      this.emit('closed');
    });
    this.proc.stderr.on('data', chunk => { this.stderr = (this.stderr + chunk).slice(-12000); });
    createInterface({ input: this.proc.stdout }).on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.method && message.id !== undefined) {
        this.requests.set(String(message.id), message);
        this.emit('request', message);
      } else if (message.id !== undefined) {
        const pending = this.pending.get(String(message.id));
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(String(message.id));
        if (message.error) pending.reject(new Error(message.error.message || '执行器请求失败'));
        else pending.resolve(message.result);
      } else if (message.method) {
        if(message.method==='serverRequest/resolved')this.requests.delete(String(message.params?.requestId));
        this.emit('notification', message);
      }
    });
    await this.call('initialize', { clientInfo: { name: 'synplex_local_prototype', title: 'Synplex', version: '0.1.0' }, capabilities: { experimentalApi: false } });
    this.send({ method: 'initialized' });
  }

  send(value) { this.proc.stdin.write(JSON.stringify(value) + '\n'); }

  call(method, params, timeout = 30000) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        reject(new Error(`执行器等待超时：${method}`));
      }, timeout);
      this.pending.set(String(id), { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }

  respond(id, result) {
    const request = this.requests.get(String(id));
    if (!request) throw new Error('此请求已处理或已失效');
    this.requests.delete(String(id));
    this.send({ id: request.id, result });
  }

  fail(error) {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }

  close() { this.proc?.stdin.end(); this.proc?.kill('SIGTERM'); }
}

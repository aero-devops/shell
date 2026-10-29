import { spawn } from 'node:child_process';

const MAX_LINE_CHARS = 16_384;

function assertSpec(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new TypeError('A process specification is required');
  if (typeof spec.command !== 'string' || !spec.command.trim() || spec.command.includes('\0')) {
    throw new TypeError('command must be a nonempty string without NUL');
  }
  if (spec.args !== undefined && (!Array.isArray(spec.args) || spec.args.some((arg) => typeof arg !== 'string' || arg.includes('\0')))) {
    throw new TypeError('args must be an array of strings without NUL');
  }
  if (spec.cwd !== undefined && (typeof spec.cwd !== 'string' || !spec.cwd.trim())) throw new TypeError('cwd must be a nonempty string');
  if (spec.timeoutMs !== undefined && (!Number.isSafeInteger(spec.timeoutMs) || spec.timeoutMs < 1 || spec.timeoutMs > 86_400_000)) {
    throw new TypeError('timeoutMs must be between 1 and 86400000');
  }
  if (spec.env !== undefined) {
    if (!spec.env || typeof spec.env !== 'object' || Array.isArray(spec.env)) throw new TypeError('env must be a record of strings');
    for (const [key, value] of Object.entries(spec.env)) {
      if (!key || key.includes('=') || key.includes('\0') || typeof value !== 'string' || value.includes('\0')) {
        throw new TypeError('env must contain valid names and string values');
      }
    }
  }
}

export function createSupervisor({ maxOutputLines = 300 } = {}) {
  if (!Number.isSafeInteger(maxOutputLines) || maxOutputLines < 1 || maxOutputLines > 10_000) {
    throw new TypeError('maxOutputLines must be between 1 and 10000');
  }
  const records = new Map();

  function snapshot(record) {
    return {
      name: record.name,
      state: record.state,
      pid: record.child.pid ?? null,
      startedAt: record.startedAt,
      endedAt: record.endedAt,
      exitCode: record.exitCode,
      signal: record.signal,
      error: record.error,
      timedOut: record.timedOut,
    };
  }

  function start(name, spec) {
    if (typeof name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name)) {
      throw new TypeError('name must be 1-64 letters, numbers, underscores, or hyphens');
    }
    assertSpec(spec);
    const previous = records.get(name);
    if (previous && (previous.state === 'running' || previous.state === 'stopping')) {
      throw new Error(`Process ${name} is already active`);
    }

    const child = spawn(spec.command, spec.args ?? [], {
      cwd: spec.cwd,
      env: { ...process.env, ...(spec.env ?? {}) },
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const record = {
      name, child, state: 'running', startedAt: new Date().toISOString(), endedAt: null,
      exitCode: null, signal: null, error: null, timedOut: false, lines: [],
    };
    records.set(name, record);

    function append(stream, text) {
      record.lines.push({ at: new Date().toISOString(), stream, text: text.slice(0, MAX_LINE_CHARS) });
      if (record.lines.length > maxOutputLines) record.lines.splice(0, record.lines.length - maxOutputLines);
    }
    function watch(stream, label) {
      stream.setEncoding('utf8');
      let pending = '';
      stream.on('data', (chunk) => {
        pending += chunk;
        let index;
        while ((index = pending.indexOf('\n')) >= 0) {
          append(label, pending.slice(0, index).replace(/\r$/, ''));
          pending = pending.slice(index + 1);
        }
        if (pending.length > MAX_LINE_CHARS) {
          append(label, pending.slice(0, MAX_LINE_CHARS));
          pending = '';
        }
      });
      stream.on('end', () => { if (pending) append(label, pending); });
    }
    watch(child.stdout, 'stdout');
    watch(child.stderr, 'stderr');

    let timeout;
    if (spec.timeoutMs) {
      timeout = setTimeout(() => {
        record.timedOut = true;
        if (record.state === 'running') {
          record.state = 'stopping';
          child.kill();
        }
      }, spec.timeoutMs);
    }
    child.on('error', (error) => { record.error = error.message; });
    record.completion = new Promise((resolve) => {
      child.on('close', (code, signal) => {
        if (timeout) clearTimeout(timeout);
        record.endedAt = new Date().toISOString();
        record.exitCode = code;
        record.signal = signal;
        record.state = record.error || record.timedOut || (code !== 0 && record.state !== 'stopping') ? 'failed' : 'exited';
        resolve(snapshot(record));
      });
    });
    return { completion: record.completion, status: () => snapshot(record) };
  }

  async function stop(name, { graceMs = 3000 } = {}) {
    if (!Number.isSafeInteger(graceMs) || graceMs < 0 || graceMs > 60_000) throw new TypeError('graceMs must be between 0 and 60000');
    const record = records.get(name);
    if (!record) throw new Error(`Unknown process: ${name}`);
    if (record.state !== 'running' && record.state !== 'stopping') return snapshot(record);
    record.state = 'stopping';
    record.child.kill();
    const fallback = setTimeout(() => { if (record.state === 'stopping') record.child.kill('SIGKILL'); }, graceMs);
    try { return await record.completion; } finally { clearTimeout(fallback); }
  }

  return {
    start,
    stop,
    status: (name) => { const record = records.get(name); return record ? snapshot(record) : null; },
    logs: (name) => { const record = records.get(name); return record ? record.lines.map((line) => ({ ...line })) : null; },
    list: () => [...records.values()].map(snapshot),
    stopAll: () => Promise.all([...records.values()].filter((record) => record.state === 'running' || record.state === 'stopping').map((record) => stop(record.name))),
  };
}


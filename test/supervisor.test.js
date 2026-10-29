import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSupervisor } from '../src/index.js';

test('captures output and exit status', async () => {
  const supervisor = createSupervisor();
  const handle = supervisor.start('sample', { command: process.execPath, args: ['-e', 'console.log("hello")'] });
  const result = await handle.completion;
  assert.equal(result.state, 'exited');
  assert.equal(result.exitCode, 0);
  assert.deepEqual(supervisor.logs('sample').map((entry) => entry.text), ['hello']);
});

test('rejects invalid specifications before spawning', () => {
  const supervisor = createSupervisor();
  assert.throws(() => supervisor.start('sample', { command: 'echo', args: 'hello' }), /args/);
  assert.throws(() => supervisor.start('bad name', { command: 'echo' }), /name/);
  assert.throws(() => supervisor.start('sample', { command: 'echo', env: { KEY: 1 } }), /env/);
});

test('stops a running child', async () => {
  const supervisor = createSupervisor();
  supervisor.start('sleeper', { command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] });
  const result = await supervisor.stop('sleeper');
  assert.equal(result.state, 'exited');
  assert.ok(result.endedAt);
});

test('times out a child', async () => {
  const supervisor = createSupervisor();
  const handle = supervisor.start('slow', { command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], timeoutMs: 100 });
  const result = await handle.completion;
  assert.equal(result.timedOut, true);
  assert.equal(result.state, 'failed');
});

test('bounds remembered output', async () => {
  const supervisor = createSupervisor({ maxOutputLines: 2 });
  const handle = supervisor.start('chatty', { command: process.execPath, args: ['-e', 'console.log("a\\nb\\nc")'] });
  await handle.completion;
  assert.deepEqual(supervisor.logs('chatty').map((entry) => entry.text), ['b', 'c']);
});


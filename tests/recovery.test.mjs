import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import { followSession, deliverWithRetry } from '../src/recovery.mjs';

const address = { kind: 'session', sessionId: 'test-session' };
const event = (seq, type, data) => ({ seq, type, time: seq, data });
const record = value => ({ type: 'event', event: value });
const frame = (socket, value) => socket.send(JSON.stringify({ type: 'item', streamId: 'task', value }));
const snapshot = (socket, events, hasMore = false, cursor = events.at(-1)?.seq ?? -1) =>
  frame(socket, { type: 'snapshot', records: events.map(record), cursor, hasMore });

async function serverFor(t, options = {}) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, ...options });
  await once(server, 'listening');
  t.after(() => {
    for (const client of server.clients) client.terminate();
    return new Promise(resolve => server.close(resolve));
  });
  return server;
}

function watch(t, server, options = {}) {
  const events = [], statuses = [], checkpoints = [];
  const follower = followSession({
    address, requestId: 'current-request',
    connect: () => new WebSocket(`ws://127.0.0.1:${server.address().port}`),
    page: async () => { throw Error('Unexpected history page request'); },
    onEvent: (value, belongs) => events.push({ value, belongs }),
    onStatus: value => statuses.push(value),
    onCheckpoint: seq => checkpoints.push(seq),
    reconnectDelays: [5], maxRetries: 3, snapshotTimeoutMs: 500, heartbeatMs: 1000,
    ...options,
  });
  t.after(() => follower.close());
  return { follower, events, statuses, checkpoints };
}

test('reconnect replays paginated missing events once and never resubmits a prompt', { timeout: 3000 }, async t => {
  const server = await serverFor(t);
  const history = [event(0, 'turn/start', { turn: 1 }), event(1, 'user/message', { source: { rpcId: 'old-request' } }),
    event(2, 'assistant/message', { content: [{ type: 'text', text: 'old answer' }] }),
    event(3, 'turn/end', { turn: 1, reason: { kind: 'completed' } })];
  let connections = 0, firstSocket, pages = 0, prompts = 0;
  server.on('connection', socket => {
    const connection = ++connections;
    if (connection === 1) firstSocket = socket;
    socket.on('message', raw => {
      const request = JSON.parse(raw.toString());
      if (request.endpoint !== 'session/follow') prompts++;
      snapshot(socket, connection === 1 ? history : history.slice(-2), connection !== 1);
    });
  });
  const { follower, events, statuses, checkpoints } = watch(t, server, {
    page: async request => {
      pages++;
      assert.equal(request.throughSeq, 9);
      assert.equal(request.beforeSeq, 8);
      return { records: history.slice(4, 8).map(record), hasMore: true };
    },
  });
  await follower.ready;
  history.push(event(4, 'turn/start', { turn: 2 }), event(5, 'user/message', { source: { rpcId: 'current-request' } }),
    event(6, 'tool/call', { turn: 2, name: 'read' }));
  for (const value of history.slice(4)) frame(firstSocket, record(value));
  await new Promise(resolve => {
    const check = setInterval(() => { if (checkpoints.includes(6)) { clearInterval(check); resolve(); } }, 2);
    t.after(() => clearInterval(check));
  });
  history.push(event(7, 'tool/result', { turn: 2 }),
    event(8, 'assistant/message', { content: [{ type: 'text', text: 'new answer' }] }),
    event(9, 'turn/end', { turn: 2, reason: { kind: 'completed' } }));
  firstSocket.terminate();
  assert.deepEqual(await follower.done, { kind: 'completed' });
  assert.deepEqual(events.map(e => e.value.seq), [4, 5, 6, 7, 8, 9]);
  assert.equal(checkpoints.at(-1), 9);
  assert.equal(connections, 2);
  assert.equal(pages, 1);
  assert.equal(prompts, 0);
  assert(statuses.some(s => s.status === 'reconnecting'));
});

test('another request completing after subscription cannot complete this task', { timeout: 3000 }, async t => {
  const server = await serverFor(t);
  let socket;
  server.on('connection', ws => { socket = ws; ws.on('message', () => snapshot(ws, [])); });
  const { follower, events } = watch(t, server);
  await follower.ready;
  const values = [event(0, 'turn/start', { turn: 1 }), event(1, 'user/message', { source: { rpcId: 'someone-else' } }),
    event(2, 'turn/end', { turn: 1, reason: { kind: 'error' } }), event(3, 'turn/start', { turn: 2 }),
    event(4, 'user/message', { source: { rpcId: 'current-request' } }),
    event(5, 'turn/end', { turn: 2, reason: { kind: 'completed' } })];
  for (const value of values) frame(socket, record(value));
  assert.deepEqual(await follower.done, { kind: 'completed' });
  assert.equal(events.find(e => e.value.seq === 2).belongs, false);
  assert.equal(events.find(e => e.value.seq === 5).belongs, true);
});

test('repeated disconnects exhaust a bounded retry budget', { timeout: 3000 }, async t => {
  const server = await serverFor(t);
  let connections = 0;
  server.on('connection', socket => {
    connections++;
    socket.on('message', () => { snapshot(socket, []); setTimeout(() => socket.terminate(), 5); });
  });
  const { follower } = watch(t, server, { maxRetries: 2 });
  await follower.ready;
  await assert.rejects(follower.done, /connection closed/);
  assert.equal(connections, 3);
});

test('heartbeat detects a silent peer and recovers completion from history', { timeout: 3000 }, async t => {
  const server = await serverFor(t, { autoPong: false });
  const history = [event(0, 'turn/start', { turn: 1 }),
    event(1, 'user/message', { source: { rpcId: 'current-request' } }),
    event(2, 'turn/end', { turn: 1, reason: { kind: 'completed' } })];
  let connections = 0;
  server.on('connection', socket => {
    const connection = ++connections;
    socket.on('message', () => snapshot(socket, connection === 1 ? [] : history));
  });
  const { follower, statuses } = watch(t, server, { heartbeatMs: 20 });
  await follower.ready;
  assert.deepEqual(await follower.done, { kind: 'completed' });
  assert.equal(connections, 2);
  assert(statuses.some(s => s.error?.includes('heartbeat')));
});

test('a missing event is reported instead of accepting an incomplete history', { timeout: 3000 }, async t => {
  const server = await serverFor(t);
  let socket;
  server.on('connection', ws => { socket = ws; ws.on('message', () => snapshot(ws, [])); });
  const { follower } = watch(t, server);
  await follower.ready;
  frame(socket, record(event(1, 'turn/end', { turn: 1, reason: { kind: 'completed' } })));
  await assert.rejects(follower.done, /history has a gap/);
});

const testRoot = process.env.DSH_TEST_ROOT || fileURLToPath(new URL('../.scratch/test-data/', import.meta.url));
function deliveryCase() {
  fs.mkdirSync(testRoot, { recursive: true });
  const dir = fs.mkdtempSync(path.join(testRoot, 'delivery-'));
  return { dir, state: { runId: 'run-1', sessionId: 'session-1', status: 'completed' }, threadId: 'thread-1', retryDelays: [1, 1] };
}

test('definitive callback failures retry delivery only; successful run IDs are not queued twice', async () => {
  const options = deliveryCase();
  let calls = 0;
  const waits = [];
  const send = () => ++calls < 3 ? { status: 1, stderr: 'temporary failure' } : { status: 0, stdout: 'Queued message q1 for thread thread-1.\n', stderr: 'Warning: thread could not be resumed.' };
  const result = await deliverWithRetry({ ...options, send, sleep: ms => waits.push(ms) });
  assert.equal(result.status, 'queued');
  assert.equal(result.attempts, 3);
  assert.match(result.receipt, /could not be resumed/);
  assert.deepEqual(waits, [1, 1]);
  await deliverWithRetry({ ...options, send });
  assert.equal(calls, 3);
  assert.equal(options.state.status, 'completed');
  assert.equal(fs.existsSync(path.join(options.dir, '.delivery.lock')), false);
});

test('exhausted delivery retries preserve the completed execution state', async () => {
  const options = deliveryCase();
  let calls = 0;
  await assert.rejects(deliverWithRetry({ ...options, send: () => { calls++; return { status: 1, stderr: 'unavailable' }; }, sleep: async () => {} }), /callback failed/);
  assert.equal(calls, 3);
  assert.equal(options.state.status, 'completed');
  assert.equal(JSON.parse(fs.readFileSync(path.join(options.dir, 'delivery.json'))).status, 'failed');
});

test('an ambiguous timeout is not retried automatically, including later invocations', async () => {
  const options = deliveryCase();
  let calls = 0;
  const send = () => { calls++; return { status: null, error: { code: 'ETIMEDOUT', message: 'timeout' } }; };
  await assert.rejects(deliverWithRetry({ ...options, send }), /may have been queued/);
  await assert.rejects(deliverWithRetry({ ...options, send }), /outcome is uncertain/);
  assert.equal(calls, 1);
});

test('an existing review acknowledges delivery without another queue message', async () => {
  const options = deliveryCase();
  fs.writeFileSync(path.join(options.dir, 'review.json'), JSON.stringify({ runId: options.state.runId, conclusion: 'passed' }));
  const result = await deliverWithRetry({ ...options, send: () => { throw Error('Must not send'); } });
  assert.equal(result.status, 'reviewed');
});

test('concurrent callback attempts cannot queue the same delivery twice', async () => {
  const options = deliveryCase();
  let complete;
  const first = deliverWithRetry({ ...options, send: () => new Promise(resolve => { complete = resolve; }) });
  await assert.rejects(deliverWithRetry({ ...options, send: () => { throw Error('Must not send'); } }), /EEXIST/);
  complete({ status: 0 });
  assert.equal((await first).queued, true);
});

test('an old failed delivery record can be retried with the same run ID', async () => {
  const options = deliveryCase();
  fs.writeFileSync(path.join(options.dir, 'delivery.json'), JSON.stringify({ runId: options.state.runId, queued: false, status: 'completed' }));
  const result = await deliverWithRetry({ ...options, send: () => ({ status: 0 }) });
  assert.equal(result.runId, options.state.runId);
  assert.equal(result.status, 'queued');
});

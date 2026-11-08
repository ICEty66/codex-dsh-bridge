import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocketServer } from 'ws';

const script = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const scratch = process.env.DSH_TEST_ROOT || fileURLToPath(new URL('../.scratch/test-data/', import.meta.url));
const record = event => ({ type: 'event', event });
const frame = (socket, value) => socket.send(JSON.stringify({ type: 'item', streamId: 'task', value }));

async function harness(t) {
  fs.mkdirSync(scratch, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratch, 'integration-'));
  const home = path.join(root, 'harness-home');
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(home); fs.mkdirSync(workspace);
  const promptFile = path.join(root, 'input.md');
  fs.writeFileSync(promptFile, '监听恢复测试\nOnly a simulated task; no real model or project.');
  const history = [
    { seq: 0, type: 'turn/start', data: { turn: 1 } },
    { seq: 1, type: 'user/message', data: { source: { rpcId: 'old-request' } } },
    { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'STALE_RESULT' }] } } },
    { seq: 3, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ];
  const calls = { prompts: [], workspaces: 0, sessions: 0, pages: 0, connections: 0 };
  let liveSocket;
  const api = http.createServer((request, response) => {
    (async () => {
      if (request.url.startsWith('/?token=')) {
        response.writeHead(303, { 'set-cookie': 'fixture=test; Path=/', location: '/' });
        response.end(); return;
      }
      assert.equal(request.headers.cookie, 'fixture=test');
      let text = '';
      for await (const chunk of request) text += chunk;
      const envelope = JSON.parse(text);
      const args = envelope.payload.args.request;
      let value;
      switch (envelope.method) {
        case 'workspace/create':
          calls.workspaces++; value = { workspace: { workspaceId: 'test-workspace' } }; break;
        case 'session/create':
          calls.sessions++; value = { sessionId: 'test-session' }; break;
        case 'session/list':
          assert.deepEqual(envelope.payload.args._request, {});
          value = { items: [{ sessionId: 'test-session', running: false, cwd: workspace }] }; break;
        case 'session/rename': value = { title: args.title, seq: 3 }; break;
        case 'session/prompt': {
          calls.prompts.push(args);
          const turn = calls.prompts.length + 1;
          value = { accepted: true };
          const start = history.length;
          history.push(
            { seq: start, type: 'turn/start', data: { turn } },
            { seq: start + 1, type: 'user/message', data: { source: { rpcId: args.requestId } } },
            { seq: start + 2, type: 'tool/call', data: { name: 'read', turn } },
          );
          for (const event of history.slice(start)) frame(liveSocket, record(event));
          setTimeout(() => {
            const final = [
              { seq: start + 3, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'RECOVERED_RESULT_' + turn }] } } },
              { seq: start + 4, type: 'turn/end', data: { turn, reason: { kind: 'completed' } } },
            ];
            history.push(...final);
            if (turn === 2) liveSocket.terminate();
            else for (const event of final) frame(liveSocket, record(event));
          }, 20);
          break;
        }
        case 'session/page':
          calls.pages++;
          assert.equal(args.throughSeq, 8);
          assert.equal(args.beforeSeq, 8);
          value = { records: history.slice(4, 8).map(record), hasMore: true }; break;
        default: throw Error('Unexpected RPC ' + envelope.method);
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ type: 'server-response', rpcId: envelope.rpcId, result: { ok: true, value } }));
    })().catch(error => { response.writeHead(500); response.end(error.message); });
  });
  const mux = new WebSocketServer({ server: api, path: '/api/remote.mux' });
  mux.on('connection', socket => {
    const connection = ++calls.connections;
    liveSocket = socket;
    socket.on('message', bytes => {
      assert.equal(JSON.parse(bytes.toString()).endpoint, 'session/follow');
      frame(socket, { type: 'snapshot', cursor: history.at(-1).seq, hasMore: connection === 2,
        records: (connection === 2 ? history.slice(-1) : history).map(record) });
    });
  });
  t.after(() => {
    for (const socket of mux.clients) socket.terminate();
    mux.close(); api.closeAllConnections();
    return new Promise(resolve => api.close(resolve));
  });
  api.listen(0, '127.0.0.1');
  await once(api, 'listening');
  const base = `http://127.0.0.1:${api.address().port}`;
  fs.writeFileSync(path.join(home, 'web-test.log'), `http://localhost:1/?token=unrelated-token\n${base}/?token=fixture-token`);
  return { root, workspace, promptFile, calls,
    dir: path.join(workspace, '2026-11-08-recovery'),
    env: { ...process.env, DSH_HOME: home, DSH_BRIDGE_URL: base } };
}

async function run(t, fixture, extra = []) {
  const child = spawn(process.execPath, [script, fixture.workspace, '2026-11-08-recovery', fixture.promptFile, ...extra], {
    env: fixture.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let stderr = '', stdout = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.on('data', chunk => { stdout += chunk; });
  const [code] = await once(child, 'close');
  assert.equal(code, 0, stderr);
  return stdout;
}

function state(fixture) { return JSON.parse(fs.readFileSync(path.join(fixture.dir, 'session.json'))); }

test('CLI recovers the final output once, then reuses the same session for related work', { timeout: 10000 }, async t => {
  const fixture = await harness(t);
  await run(t, fixture);
  assert.equal(state(fixture).status, 'completed');
  assert.equal(state(fixture).executionStatus, 'completed');
  assert.equal(state(fixture).monitorStatus, 'finished');
  assert.equal(state(fixture).lastSeq, 8);
  assert.equal(fs.readFileSync(path.join(fixture.dir, 'result.md'), 'utf8').trim(), 'RECOVERED_RESULT_2');
  assert.equal(fixture.calls.prompts.length, 1);
  assert.equal(fixture.calls.connections, 2);
  assert.equal(fixture.calls.pages, 1);
  assert.equal(fs.existsSync(path.join(fixture.dir, '.running')), false);
  const sequences = fs.readFileSync(path.join(fixture.dir, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line).seq);
  assert.deepEqual(sequences, [4, 5, 6, 7, 8]);
  const firstRequestId = state(fixture).requestId;
  await run(t, fixture);
  assert.equal(fixture.calls.sessions, 1);
  assert.equal(fixture.calls.workspaces, 1);
  assert.equal(fixture.calls.prompts.length, 2);
  assert.equal(state(fixture).sessionId, 'test-session');
  assert.equal(state(fixture).lastSeq, 13);
  assert.notEqual(state(fixture).requestId, firstRequestId);
  assert.equal(fs.readFileSync(path.join(fixture.dir, 'result.md'), 'utf8').trim(), 'RECOVERED_RESULT_3');
});

test('async supervisor returns a receipt, queues delivery to the origin, and skips a duplicate callback', { timeout: 10000 }, async t => {
  const fixture = await harness(t);
  const preload = path.join(fixture.root, 'fake-queue.cjs');
  const trace = path.join(fixture.root, 'queue-calls.jsonl');
  fs.writeFileSync(preload, `
if (/(?:^|[\\\\/])queue$/.test(process.argv[1] || '')) {
  const fs = require('node:fs');
  fs.appendFileSync(process.env.BRIDGE_QUEUE_TRACE, JSON.stringify(process.argv.slice(2)) + '\\n');
  console.log('Queued message fixture for thread ' + process.argv[process.argv.indexOf('--thread') + 1] + '.');
  process.exit(0);
}`);
  fixture.env = { ...fixture.env, CODEX_BIN: process.execPath,
    CODEX_THREAD_ID: '11111111-1111-4111-8111-111111111111', BRIDGE_QUEUE_TRACE: trace,
    NODE_OPTIONS: '--require "' + preload.replaceAll('\\', '/') + '"' };
  const receipt = JSON.parse((await run(t, fixture, ['--async'])).trim());
  assert.equal(receipt.accepted, true);
  assert.equal(receipt.callbackThreadId, fixture.env.CODEX_THREAD_ID);
  t.after(() => {
    const lock = path.join(fixture.dir, '.running');
    if (fs.existsSync(lock) && fs.readFileSync(lock, 'utf8') === String(receipt.pid)) {
      try { process.kill(receipt.pid); } catch {}
    }
  });
  const deliveryPath = path.join(fixture.dir, 'delivery.json');
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (fs.existsSync(deliveryPath) && !fs.existsSync(path.join(fixture.dir, '.running'))) break;
    await delay(10);
  }
  const delivery = JSON.parse(fs.readFileSync(deliveryPath));
  assert.equal(delivery.status, 'queued');
  assert.equal(delivery.runId, receipt.runId);
  assert.equal(delivery.threadId, fixture.env.CODEX_THREAD_ID);
  assert.equal(fixture.calls.prompts.length, 1);
  assert.equal(state(fixture).status, 'completed');
  assert.equal(fs.existsSync(path.join(fixture.dir, '.running')), false);
  const queued = JSON.parse(fs.readFileSync(trace, 'utf8').trim());
  assert(queued.includes('--resume'));
  assert.equal(queued[queued.indexOf('--thread') + 1], fixture.env.CODEX_THREAD_ID);
  assert(queued[queued.indexOf('--message') + 1].includes(receipt.runId));
  const retry = spawn(process.execPath, [script, '--retry-delivery', fixture.dir], { env: fixture.env, windowsHide: true, stdio: 'ignore' });
  assert.equal((await once(retry, 'exit'))[0], 0);
  assert.equal(fs.readFileSync(trace, 'utf8').trim().split('\n').length, 1);
  assert.equal(fixture.calls.prompts.length, 1);
});
